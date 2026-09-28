import {
  benchmarkRequestEndMs,
  type BenchmarkReplayFidelity,
  type BenchmarkReplayFidelityRecord,
  type BenchmarkReplaySegmentResult,
  type BenchmarkReplaySummary,
  type BenchmarkRequestResult,
  type WorkloadDatasetRecord,
  type WorkloadDatasetSegment,
} from "@arriero/core";

import { knownSum, percentile } from "../utils/statistics.js";
import { workloadCacheMetrics } from "../workload/record-analysis.js";
import { weightedAcceptance } from "./segmenter.js";

export type ReplayRequestPlacement = {
  segmentIndex: number;
  recordIndex: number;
};

export function replayRequestId(placement: ReplayRequestPlacement): string {
  return `${placement.segmentIndex}:${placement.recordIndex}`;
}

function replayRequestPlacement(
  requestId: string,
): ReplayRequestPlacement | null {
  const match = /^(\d+):(\d+)$/.exec(requestId);
  if (!match) {
    return null;
  }
  return { segmentIndex: Number(match[1]), recordIndex: Number(match[2]) };
}

function decodeRate(
  requests: readonly BenchmarkRequestResult[],
): number | null {
  let tokens = 0;
  let durationMs = 0;
  for (const request of requests) {
    if (
      request.clientDecodeTokensPerSecond === null ||
      request.firstTokenMs === null ||
      request.doneMs === null ||
      request.doneMs <= request.firstTokenMs
    ) {
      continue;
    }
    const duration = request.doneMs - request.firstTokenMs;
    tokens += (request.clientDecodeTokensPerSecond * duration) / 1000;
    durationMs += duration;
  }
  return durationMs > 0 ? (tokens * 1000) / durationMs : null;
}

function segmentResult(input: {
  segment: WorkloadDatasetSegment;
  segmentIndex: number;
  primed: boolean;
  requests: BenchmarkRequestResult[];
}): BenchmarkReplaySegmentResult {
  const { requests } = input;
  const successful = requests.filter((request) => request.error === null);
  const ttft = successful.flatMap((request) =>
    request.firstTokenMs === null
      ? []
      : [request.firstTokenMs - request.submitMs],
  );
  const starts = requests.map((request) => request.submitMs);
  const ends = requests.map(benchmarkRequestEndMs);
  return {
    segmentIndex: input.segmentIndex,
    sessionId: input.segment.sessionId,
    windowIndex: input.segment.windowIndex,
    primed: input.primed,
    requestCount: requests.length,
    failedRequestCount: requests.length - successful.length,
    promptTokens: knownSum(successful.map((request) => request.promptTokens)),
    cachedPromptTokens: knownSum(
      successful.map((request) => request.cachedPromptTokens),
    ),
    completionTokens: knownSum(
      successful.map((request) => request.completionTokens),
    ),
    timeToFirstTokenP50Ms: percentile(ttft, 0.5),
    timeToFirstTokenP95Ms: percentile(ttft, 0.95),
    decodeTokensPerSecond: decodeRate(successful),
    acceptanceRate: weightedAcceptance(successful),
    wallMs:
      requests.length > 0 ? Math.max(...ends) - Math.min(...starts) : null,
  };
}

function responseReuseTokens(
  parent: WorkloadDatasetRecord | null,
  child: WorkloadDatasetRecord,
): number | null {
  if (!parent) {
    return null;
  }
  return workloadCacheMetrics(
    { targetId: parent.targetName, promptTokens: parent.promptTokens },
    { targetId: child.targetName, cacheReadTokens: child.cacheReadTokens },
  ).responseReuseTokens;
}

function fidelityRecords(
  segments: readonly WorkloadDatasetSegment[],
  requests: readonly BenchmarkRequestResult[],
): BenchmarkReplayFidelityRecord[] {
  return requests.flatMap((request) => {
    const placement = replayRequestPlacement(request.requestId);
    const segment = placement ? segments[placement.segmentIndex] : undefined;
    const record =
      placement && segment ? segment.records[placement.recordIndex] : undefined;
    if (!placement || !segment || !record || request.error !== null) {
      return [];
    }
    const parent =
      placement.recordIndex > 0
        ? (segment.records[placement.recordIndex - 1] ?? null)
        : segment.priming;
    return [
      {
        requestId: request.requestId,
        segmentIndex: placement.segmentIndex,
        recordIndex: placement.recordIndex,
        traceId: record.traceId,
        recordedPromptTokens: record.promptTokens,
        recordedCachedPromptTokens: record.cacheReadTokens,
        replayedPromptTokens: request.promptTokens,
        replayedCachedPromptTokens: request.cachedPromptTokens,
        responseReuseTokens: responseReuseTokens(parent, record),
      },
    ];
  });
}

function fidelitySummary(
  records: readonly BenchmarkReplayFidelityRecord[],
): BenchmarkReplayFidelity {
  const summary: BenchmarkReplayFidelity = {
    comparedRequestCount: 0,
    uncomparedRequestCount: 0,
    recordedPromptTokens: 0,
    recordedCachedPromptTokens: 0,
    replayedPromptTokens: 0,
    replayedCachedPromptTokens: 0,
    responseReuseTokens: 0,
  };
  for (const record of records) {
    if (
      record.recordedPromptTokens === null ||
      record.recordedCachedPromptTokens === null ||
      record.replayedPromptTokens === null ||
      record.replayedCachedPromptTokens === null
    ) {
      summary.uncomparedRequestCount += 1;
      continue;
    }
    summary.comparedRequestCount += 1;
    summary.recordedPromptTokens += record.recordedPromptTokens;
    summary.recordedCachedPromptTokens += record.recordedCachedPromptTokens;
    summary.replayedPromptTokens += record.replayedPromptTokens;
    summary.replayedCachedPromptTokens += record.replayedCachedPromptTokens;
    summary.responseReuseTokens += record.responseReuseTokens ?? 0;
  }
  return summary;
}

export function analyzeReplayRequests(input: {
  segments: readonly WorkloadDatasetSegment[];
  primedSegments: ReadonlySet<number>;
  requests: readonly BenchmarkRequestResult[];
  recordedArrival: boolean;
}): {
  summary: BenchmarkReplaySummary;
  fidelity: BenchmarkReplayFidelityRecord[] | null;
} {
  const bySegment = new Map<number, BenchmarkRequestResult[]>();
  for (const request of input.requests) {
    const placement = replayRequestPlacement(request.requestId);
    if (!placement) {
      continue;
    }
    const group = bySegment.get(placement.segmentIndex) ?? [];
    group.push(request);
    bySegment.set(placement.segmentIndex, group);
  }
  const fidelity = input.recordedArrival
    ? fidelityRecords(input.segments, input.requests)
    : null;
  return {
    summary: {
      segments: input.segments.map((segment, segmentIndex) =>
        segmentResult({
          segment,
          segmentIndex,
          primed: input.primedSegments.has(segmentIndex),
          requests: bySegment.get(segmentIndex) ?? [],
        }),
      ),
      fidelity: fidelity ? fidelitySummary(fidelity) : null,
    },
    fidelity,
  };
}
