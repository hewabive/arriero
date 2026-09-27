import type {
  WorkloadLinkingGroup,
  WorkloadProfileWindow,
  WorkloadRankedWindow,
  WorkloadRecord,
  WorkloadSessionSummary,
  WorkloadWindowRank,
} from "@arriero/core";

export const MAX_WORKLOAD_PROFILE_WINDOWS = 2000;

export type WorkloadProfileRange = {
  fromMs: number;
  toMs: number;
  windowMs: number;
  stepMs: number;
};

type Interval = {
  startMs: number;
  endMs: number;
  record: WorkloadRecord;
};

function toIntervals(records: WorkloadRecord[]): Interval[] {
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

function percentile(values: number[], share: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(share * sorted.length) - 1),
  );
  return sorted[index] ?? null;
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

function servedAnswer(record: WorkloadRecord): boolean {
  return record.outcome === "success" || record.outcome === "client-abort";
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
    promptTokensP50: percentile(
      records.flatMap((record) =>
        record.promptTokens === null ? [] : [record.promptTokens],
      ),
      0.5,
    ),
    promptTokensP90: percentile(
      records.flatMap((record) =>
        record.promptTokens === null ? [] : [record.promptTokens],
      ),
      0.9,
    ),
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
    completionTokensP50: percentile(
      records.flatMap((record) =>
        record.completionTokens === null || !servedAnswer(record)
          ? []
          : [record.completionTokens],
      ),
      0.5,
    ),
    completionTokensP90: percentile(
      records.flatMap((record) =>
        record.completionTokens === null || !servedAnswer(record)
          ? []
          : [record.completionTokens],
      ),
      0.9,
    ),
    cacheLossTokens: sumOrNull(records.map((record) => record.cacheLossTokens)),
    responseReuseTokens: sumOrNull(
      records.map((record) => record.responseReuseTokens),
    ),
  };
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
  records: WorkloadRecord[],
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

const TYPICAL_FEATURES = [
  "activeSessions",
  "requests",
  "meanInFlight",
  "promptTokensP50",
  "freshPrefillTokens",
  "completionTokensP50",
] as const satisfies ReadonlyArray<keyof WorkloadProfileWindow>;

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function typicalScores(windows: WorkloadProfileWindow[]): number[] {
  const medians = TYPICAL_FEATURES.map((feature) =>
    median(
      windows.flatMap((window) => {
        const value = window[feature];
        return value === null ? [] : [value];
      }),
    ),
  );
  return windows.map((window) =>
    TYPICAL_FEATURES.reduce((score, feature, index) => {
      const value = window[feature];
      const middle = medians[index] ?? null;
      if (value === null || middle === null) {
        return score;
      }
      return score + Math.abs(Math.log((value + 1) / (middle + 1)));
    }, 0),
  );
}

function overlaps(
  left: WorkloadProfileWindow,
  right: WorkloadProfileWindow,
): boolean {
  return left.startAt < right.endAt && right.startAt < left.endAt;
}

export function rankWorkloadWindows(
  windows: WorkloadProfileWindow[],
  rank: WorkloadWindowRank,
  limit: number,
): WorkloadRankedWindow[] {
  const candidates = windows.filter(
    (window) => window.requests > 0 && window.errors === 0,
  );
  const scores =
    rank === "typical"
      ? typicalScores(candidates)
      : candidates.map((window) => window.meanInFlight);
  const ranked = candidates
    .map((window, index) => ({ ...window, score: scores[index] ?? 0 }))
    .sort((left, right) => {
      if (rank === "typical") {
        return (
          left.score - right.score || left.startAt.localeCompare(right.startAt)
        );
      }
      return (
        right.score - left.score ||
        (right.freshPrefillTokens ?? -1) - (left.freshPrefillTokens ?? -1) ||
        left.startAt.localeCompare(right.startAt)
      );
    });
  const picked: WorkloadRankedWindow[] = [];
  for (const window of ranked) {
    if (picked.length >= limit) {
      break;
    }
    if (!picked.some((existing) => overlaps(existing, window))) {
      picked.push(window);
    }
  }
  return picked;
}

export function workloadLinkingGroups(
  records: WorkloadRecord[],
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

export function summarizeWorkloadSession(
  records: WorkloadRecord[],
): WorkloadSessionSummary | null {
  const first = records[0];
  if (!first) {
    return null;
  }
  let endedAt = first.endAt;
  let maxPromptTokens: number | null = null;
  const targetNames = new Set<string>();
  for (const record of records) {
    if (record.endAt > endedAt) {
      endedAt = record.endAt;
    }
    if (record.promptTokens !== null) {
      maxPromptTokens = Math.max(maxPromptTokens ?? 0, record.promptTokens);
    }
    if (record.targetName !== null) {
      targetNames.add(record.targetName);
    }
  }
  return {
    sessionId: first.sessionId,
    sourceId: first.sourceId,
    sourceName: first.sourceName,
    modelId: first.modelId,
    startedAt: first.at,
    endedAt,
    records: records.length,
    replayable: records.filter(
      (record) => record.issue === null && servedAnswer(record),
    ).length,
    errors: records.filter((record) => record.outcome === "error").length,
    notServed: records.filter((record) => record.outcome === "not-served")
      .length,
    clientAborts: records.filter((record) => record.outcome === "client-abort")
      .length,
    maxPromptTokens,
    targetNames: [...targetNames].sort(),
  };
}
