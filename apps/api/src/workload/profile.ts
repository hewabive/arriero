import {
  MAX_WORKLOAD_PROFILE_WINDOWS,
  workloadPercentile,
  type WorkloadLinkingGroup,
  type WorkloadProfileWindow,
  type WorkloadRecord,
} from "@arriero/core";

import { isServedWorkloadOutcome } from "./record-analysis.js";

export type WorkloadProfileRecord = Pick<
  WorkloadRecord,
  | "at"
  | "durationMs"
  | "sessionId"
  | "outcome"
  | "promptTokens"
  | "cacheReadTokens"
  | "completionTokens"
  | "cacheLossTokens"
  | "responseReuseTokens"
>;

export type WorkloadLinkingRecord = Pick<
  WorkloadRecord,
  | "traceId"
  | "sourceId"
  | "sourceName"
  | "modelId"
  | "sessionId"
  | "messageCount"
  | "parentTraceId"
  | "clientSessionId"
>;

export type WorkloadProfileRange = {
  fromMs: number;
  toMs: number;
  windowMs: number;
  stepMs: number;
};

type Interval = {
  startMs: number;
  endMs: number;
  record: WorkloadProfileRecord;
};

function toIntervals(records: WorkloadProfileRecord[]): Interval[] {
  const intervals: Interval[] = [];
  for (const record of records) {
    const startMs = Date.parse(record.at);
    if (!Number.isFinite(startMs)) {
      continue;
    }
    intervals.push({
      startMs,
      endMs: startMs + Math.max(1, record.durationMs),
      record,
    });
  }
  return intervals.sort((left, right) => left.startMs - right.startMs);
}

function ascending(values: number[]): number[] {
  return values.sort((left, right) => left - right);
}

function sumOrNull(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) {
      total = (total ?? 0) + value;
    }
  }
  return total;
}

export function maxKnown(values: Array<number | null>): number | null {
  let highest: number | null = null;
  for (const value of values) {
    if (value !== null && (highest === null || value > highest)) {
      highest = value;
    }
  }
  return highest;
}

export function latestEndAt(
  records: ReadonlyArray<{ endAt: string }>,
  floor: string,
): string {
  return records.reduce(
    (latest, record) => (record.endAt > latest ? record.endAt : latest),
    floor,
  );
}

function describeWindow(
  intervals: Interval[],
  startMs: number,
  endMs: number,
): WorkloadProfileWindow {
  const starting = intervals.filter(
    (interval) => interval.startMs >= startMs && interval.startMs < endMs,
  );
  const overlapping = intervals.filter(
    (interval) => interval.startMs < endMs && interval.endMs > startMs,
  );
  const inFlightMs = overlapping.reduce(
    (total, interval) =>
      total +
      Math.min(interval.endMs, endMs) -
      Math.max(interval.startMs, startMs),
    0,
  );
  const records = starting.map((interval) => interval.record);
  const withCache = records.filter(
    (record) => record.promptTokens !== null && record.cacheReadTokens !== null,
  );
  const cachedPromptTokens = sumOrNull(
    withCache.map((record) => record.cacheReadTokens),
  );
  const promptTokensWithCache = sumOrNull(
    withCache.map((record) => record.promptTokens),
  );
  const promptTokens = ascending(
    records.flatMap((record) =>
      record.promptTokens === null ? [] : [record.promptTokens],
    ),
  );
  const completionTokens = ascending(
    records.flatMap((record) =>
      record.completionTokens === null ||
      !isServedWorkloadOutcome(record.outcome)
        ? []
        : [record.completionTokens],
    ),
  );
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    requests: records.length,
    errors: records.filter((record) => record.outcome === "error").length,
    notServed: records.filter((record) => record.outcome === "not-served")
      .length,
    activeSessions: new Set(
      overlapping.map((interval) => interval.record.sessionId),
    ).size,
    meanInFlight: inFlightMs / Math.max(1, endMs - startMs),
    promptTokensP50: workloadPercentile(promptTokens, 0.5),
    promptTokensP90: workloadPercentile(promptTokens, 0.9),
    freshPrefillTokens:
      promptTokensWithCache === null || cachedPromptTokens === null
        ? null
        : promptTokensWithCache - cachedPromptTokens,
    cachedPromptTokens,
    cachedShare:
      promptTokensWithCache === null ||
      cachedPromptTokens === null ||
      promptTokensWithCache === 0
        ? null
        : cachedPromptTokens / promptTokensWithCache,
    completionTokensP50: workloadPercentile(completionTokens, 0.5),
    completionTokensP90: workloadPercentile(completionTokens, 0.9),
    cacheLossTokens: sumOrNull(records.map((record) => record.cacheLossTokens)),
    responseReuseTokens: sumOrNull(
      records.map((record) => record.responseReuseTokens),
    ),
  };
}

export function describeWorkloadPeriod(
  records: WorkloadProfileRecord[],
  fromMs: number,
  toMs: number,
): WorkloadProfileWindow {
  return describeWindow(toIntervals(records), fromMs, toMs);
}

function firstIndexAtOrAfter(intervals: Interval[], startMs: number): number {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((intervals[middle]?.startMs ?? 0) < startMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function workloadProfileWindowCount(
  range: WorkloadProfileRange,
): number {
  const first = Math.floor(range.fromMs / range.stepMs) * range.stepMs;
  return Math.max(0, Math.ceil((range.toMs - first) / range.stepMs));
}

export function buildWorkloadProfile(
  records: WorkloadProfileRecord[],
  range: WorkloadProfileRange,
): { period: WorkloadProfileWindow; windows: WorkloadProfileWindow[] } {
  const intervals = toIntervals(records);
  const longestMs = intervals.reduce(
    (longest, interval) => Math.max(longest, interval.endMs - interval.startMs),
    0,
  );
  const windows: WorkloadProfileWindow[] = [];
  const first = Math.floor(range.fromMs / range.stepMs) * range.stepMs;
  for (
    let startMs = first;
    startMs < range.toMs && windows.length < MAX_WORKLOAD_PROFILE_WINDOWS;
    startMs += range.stepMs
  ) {
    const endMs = startMs + range.windowMs;
    const lower = firstIndexAtOrAfter(intervals, startMs - longestMs);
    const upper = firstIndexAtOrAfter(intervals, endMs);
    windows.push(describeWindow(intervals.slice(lower, upper), startMs, endMs));
  }
  return {
    period: describeWindow(intervals, range.fromMs, range.toMs),
    windows,
  };
}

export function workloadLinkingGroups(
  records: WorkloadLinkingRecord[],
): WorkloadLinkingGroup[] {
  const byTrace = new Map(records.map((record) => [record.traceId, record]));
  const groups = new Map<
    string,
    WorkloadLinkingGroup & {
      sessionIds: Set<string>;
      clientSessionIds: Set<string>;
    }
  >();
  for (const record of records) {
    if (record.messageCount === null) {
      continue;
    }
    const key = JSON.stringify([record.sourceId, record.modelId]);
    const group = groups.get(key) ?? {
      sourceId: record.sourceId,
      sourceName: record.sourceName,
      modelId: record.modelId,
      linkableRecords: 0,
      linkedRecords: 0,
      sessions: 0,
      clientSessions: 0,
      clientSessionPairs: 0,
      clientSessionAgreeing: 0,
      sessionIds: new Set<string>(),
      clientSessionIds: new Set<string>(),
    };
    group.linkableRecords += 1;
    group.sessionIds.add(record.sessionId);
    if (record.clientSessionId !== null) {
      group.clientSessionIds.add(record.clientSessionId);
    }
    if (record.parentTraceId !== null) {
      group.linkedRecords += 1;
      const parent = byTrace.get(record.parentTraceId);
      if (
        parent &&
        parent.clientSessionId !== null &&
        record.clientSessionId !== null
      ) {
        group.clientSessionPairs += 1;
        if (parent.clientSessionId === record.clientSessionId) {
          group.clientSessionAgreeing += 1;
        }
      }
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ sessionIds, clientSessionIds, ...group }) => ({
      ...group,
      sessions: sessionIds.size,
      clientSessions: clientSessionIds.size,
    }))
    .sort(
      (left, right) =>
        (left.sourceName ?? "").localeCompare(right.sourceName ?? "") ||
        left.modelId.localeCompare(right.modelId),
    );
}
