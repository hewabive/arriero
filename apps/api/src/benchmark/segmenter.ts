import { BENCHMARK_CLASS_MIN_WALL_MS, soloDecodeBaseline } from "@arriero/core";
import type {
  BenchmarkHeadline,
  BenchmarkRequestResult,
  BenchmarkRunResult,
  BenchmarkRunSummary,
  BenchmarkSegment,
  BenchmarkSegmentClass,
  BenchmarkServerTimings,
  BenchmarkTopicSummary,
} from "@arriero/core";

export type MeasuredRequest = {
  requestId: string;
  promptId: string;
  topic: string;
  language: string;
  repetition: number;
  submitMs: number;
  firstTokenMs: number | null;
  doneMs: number | null;
  chunkTimesMs: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  serverTimings: BenchmarkServerTimings | null;
  finishReason: string | null;
  error: string | null;
};

type RequestPhases = {
  requestId: string;
  topic: string;
  language: string;
  prefillStartMs: number;
  firstTokenMs: number;
  doneMs: number;
  tokensPerChunk: number;
  decodeChunkTimes: number[];
};

type ContentionAccumulator = {
  soloTokens: number;
  soloMs: number;
  contendedTokens: number;
  contendedMs: number;
};

function ratePerSecond(tokens: number, durationMs: number): number | null {
  return durationMs > 0 ? (tokens / durationMs) * 1000 : null;
}

function supportedRate(tokens: number, durationMs: number): number | null {
  return durationMs >= BENCHMARK_CLASS_MIN_WALL_MS
    ? ratePerSecond(tokens, durationMs)
    : null;
}

function tokensPerChunkOf(request: MeasuredRequest): number {
  const chunkCount = request.chunkTimesMs.length;
  if (request.completionTokens !== null && chunkCount > 0) {
    return request.completionTokens / chunkCount;
  }
  return 1;
}

function prefillStartOf(request: MeasuredRequest): number | null {
  const promptMs = request.serverTimings?.promptMs ?? null;
  if (promptMs === null || request.firstTokenMs === null) {
    return null;
  }
  return Math.max(request.submitMs, request.firstTokenMs - promptMs);
}

function phasesOf(request: MeasuredRequest): RequestPhases | null {
  if (request.firstTokenMs === null || request.doneMs === null) {
    return null;
  }
  return {
    requestId: request.requestId,
    topic: request.topic,
    language: request.language,
    prefillStartMs: prefillStartOf(request) ?? request.submitMs,
    firstTokenMs: request.firstTokenMs,
    doneMs: request.doneMs,
    tokensPerChunk: tokensPerChunkOf(request),
    decodeChunkTimes: request.chunkTimesMs.slice(1),
  };
}

function countChunksThrough(
  phase: RequestPhases,
  cursors: Map<RequestPhases, number>,
  startMs: number,
  endMs: number,
): number {
  const times = phase.decodeChunkTimes;
  let cursor = cursors.get(phase) ?? 0;
  let chunks = 0;
  while (cursor < times.length) {
    const chunkMs = times[cursor];
    if (chunkMs === undefined) break;
    const within =
      chunkMs < endMs || (chunkMs === endMs && endMs === phase.doneMs);
    if (!within) break;
    if (chunkMs >= startMs) chunks += 1;
    cursor += 1;
  }
  cursors.set(phase, cursor);
  return chunks;
}

function buildRepetitionSegments(
  phases: RequestPhases[],
  repetition: number,
  contention: Map<string, ContentionAccumulator>,
): BenchmarkSegment[] {
  const boundaries = new Set<number>();
  for (const phase of phases) {
    boundaries.add(phase.prefillStartMs);
    boundaries.add(phase.firstTokenMs);
    boundaries.add(phase.doneMs);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const cursors = new Map<RequestPhases, number>();
  const segments: BenchmarkSegment[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const startMs = sorted[index];
    const endMs = sorted[index + 1];
    if (startMs === undefined || endMs === undefined) continue;
    const prefilling = phases.filter(
      (phase) =>
        phase.prefillStartMs <= startMs && startMs < phase.firstTokenMs,
    );
    const decoding = phases.filter(
      (phase) => phase.firstTokenMs <= startMs && startMs < phase.doneMs,
    );
    const contended = prefilling.length > 0 || decoding.length > 1;
    let decodeTokens = 0;
    for (const phase of decoding) {
      const chunks = countChunksThrough(phase, cursors, startMs, endMs);
      const tokens = chunks * phase.tokensPerChunk;
      decodeTokens += tokens;
      const accumulator = contention.get(phase.requestId) ?? {
        soloTokens: 0,
        soloMs: 0,
        contendedTokens: 0,
        contendedMs: 0,
      };
      if (contended) {
        accumulator.contendedTokens += tokens;
        accumulator.contendedMs += endMs - startMs;
      } else {
        accumulator.soloTokens += tokens;
        accumulator.soloMs += endMs - startMs;
      }
      contention.set(phase.requestId, accumulator);
    }
    segments.push({
      repetition,
      startMs,
      endMs,
      prefillCount: prefilling.length,
      decodeCount: decoding.length,
      decodeTokens,
      decodeTokensPerSecond: ratePerSecond(decodeTokens, endMs - startMs),
    });
  }
  return segments;
}

function aggregateSegmentClasses(
  segments: BenchmarkSegment[],
): BenchmarkSegmentClass[] {
  const totalWallMs = segments.reduce(
    (sum, segment) => sum + (segment.endMs - segment.startMs),
    0,
  );
  const classes = new Map<
    string,
    {
      prefillCount: number;
      decodeCount: number;
      wallMs: number;
      tokens: number;
    }
  >();
  for (const segment of segments) {
    const key = `${segment.prefillCount}/${segment.decodeCount}`;
    const entry = classes.get(key) ?? {
      prefillCount: segment.prefillCount,
      decodeCount: segment.decodeCount,
      wallMs: 0,
      tokens: 0,
    };
    entry.wallMs += segment.endMs - segment.startMs;
    entry.tokens += segment.decodeTokens;
    classes.set(key, entry);
  }
  return [...classes.values()]
    .sort(
      (a, b) =>
        a.prefillCount - b.prefillCount || a.decodeCount - b.decodeCount,
    )
    .map((entry) => {
      const decodeTokensPerSecond = ratePerSecond(entry.tokens, entry.wallMs);
      return {
        prefillCount: entry.prefillCount,
        decodeCount: entry.decodeCount,
        wallMs: entry.wallMs,
        wallShare: totalWallMs > 0 ? entry.wallMs / totalWallMs : 0,
        decodeTokens: entry.tokens,
        decodeTokensPerSecond,
        perRequestDecodeTokensPerSecond:
          decodeTokensPerSecond !== null && entry.decodeCount > 0
            ? decodeTokensPerSecond / entry.decodeCount
            : null,
      };
    });
}

function weightedAcceptance(
  requests: readonly MeasuredRequest[],
): number | null {
  let drafted = 0;
  let accepted = 0;
  for (const request of requests) {
    const timings = request.serverTimings;
    if (
      timings &&
      timings.draftN !== null &&
      timings.draftNAccepted !== null &&
      timings.draftN > 0
    ) {
      drafted += timings.draftN;
      accepted += timings.draftNAccepted;
    }
  }
  return drafted > 0 ? accepted / drafted : null;
}

function buildTopicSummaries(
  requests: readonly MeasuredRequest[],
  contention: Map<string, ContentionAccumulator>,
): BenchmarkTopicSummary[] {
  const groups = new Map<string, MeasuredRequest[]>();
  for (const request of requests) {
    const key = `${request.topic}\u0000${request.language}`;
    const group = groups.get(key) ?? [];
    group.push(request);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const first = group[0];
      let soloTokens = 0;
      let soloMs = 0;
      let contendedTokens = 0;
      let contendedMs = 0;
      const firstTokenSpans: number[] = [];
      for (const request of group) {
        const accumulator = contention.get(request.requestId);
        if (accumulator) {
          soloTokens += accumulator.soloTokens;
          soloMs += accumulator.soloMs;
          contendedTokens += accumulator.contendedTokens;
          contendedMs += accumulator.contendedMs;
        }
        if (request.firstTokenMs !== null) {
          firstTokenSpans.push(request.firstTokenMs - request.submitMs);
        }
      }
      return {
        topic: first?.topic ?? "",
        language: first?.language ?? "",
        requestCount: group.length,
        soloDecodeTokensPerSecond: supportedRate(soloTokens, soloMs),
        contendedDecodeTokensPerSecond: supportedRate(
          contendedTokens,
          contendedMs,
        ),
        acceptanceRate: weightedAcceptance(group),
        averageTimeToFirstTokenMs:
          firstTokenSpans.length > 0
            ? firstTokenSpans.reduce((sum, span) => sum + span, 0) /
              firstTokenSpans.length
            : null,
      };
    });
}

function buildRequestResult(
  request: MeasuredRequest,
  phases: RequestPhases | null,
): BenchmarkRequestResult {
  const decodeTokens = phases
    ? phases.decodeChunkTimes.length * phases.tokensPerChunk
    : 0;
  return {
    requestId: request.requestId,
    promptId: request.promptId,
    topic: request.topic,
    language: request.language,
    repetition: request.repetition,
    submitMs: request.submitMs,
    prefillStartMs: prefillStartOf(request),
    firstTokenMs: request.firstTokenMs,
    doneMs: request.doneMs,
    chunkCount: request.chunkTimesMs.length,
    promptTokens: request.promptTokens,
    completionTokens: request.completionTokens,
    clientDecodeTokensPerSecond: phases
      ? ratePerSecond(decodeTokens, phases.doneMs - phases.firstTokenMs)
      : null,
    serverTimings: request.serverTimings,
    acceptanceRate: weightedAcceptance([request]),
    finishReason: request.finishReason,
    error: request.error,
  };
}

export type BenchmarkRunAnalysis = {
  result: BenchmarkRunResult;
  summary: BenchmarkRunSummary;
};

export function analyzeBenchmarkRun(
  requests: readonly MeasuredRequest[],
): BenchmarkRunAnalysis {
  const contention = new Map<string, ContentionAccumulator>();
  const phasesByRequest = new Map<MeasuredRequest, RequestPhases | null>();
  const repetitions = new Map<number, RequestPhases[]>();
  for (const request of requests) {
    const phases = phasesOf(request);
    phasesByRequest.set(request, phases);
    if (!phases) continue;
    const group = repetitions.get(request.repetition) ?? [];
    group.push(phases);
    repetitions.set(request.repetition, group);
  }
  const segments: BenchmarkSegment[] = [];
  for (const [repetition, group] of [...repetitions.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    segments.push(...buildRepetitionSegments(group, repetition, contention));
  }
  const segmentClasses = aggregateSegmentClasses(segments);
  const topics = buildTopicSummaries(requests, contention);
  const result: BenchmarkRunResult = {
    requests: [...requests]
      .sort((a, b) => a.submitMs - b.submitMs)
      .map((request) =>
        buildRequestResult(request, phasesByRequest.get(request) ?? null),
      ),
    segments,
  };
  return {
    result,
    summary: summarizeRequests(requests, segments, segmentClasses, topics),
  };
}

function percentile(
  sorted: readonly number[],
  quantile: number,
): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = (sorted.length - 1) * quantile;
  const lower = sorted[Math.floor(rank)];
  const upper = sorted[Math.ceil(rank)];
  if (lower === undefined || upper === undefined) {
    return null;
  }
  return lower + (upper - lower) * (rank - Math.floor(rank));
}

function buildHeadline(
  requests: readonly MeasuredRequest[],
  segments: readonly BenchmarkSegment[],
  segmentClasses: readonly BenchmarkSegmentClass[],
): BenchmarkHeadline {
  let decodeTokens = 0;
  let decodeWallMs = 0;
  let perRequestTokens = 0;
  for (const entry of segmentClasses) {
    if (entry.decodeCount === 0) continue;
    decodeTokens += entry.decodeTokens;
    decodeWallMs += entry.wallMs;
    perRequestTokens += entry.decodeTokens / entry.decodeCount;
  }
  let totalPromptTokens = 0;
  let prefillTokens = 0;
  let prefillMs = 0;
  const firstTokenSpans: number[] = [];
  for (const request of requests) {
    totalPromptTokens += request.promptTokens ?? 0;
    if (request.firstTokenMs === null) continue;
    firstTokenSpans.push(request.firstTokenMs - request.submitMs);
    const prefillStartMs = prefillStartOf(request);
    if (prefillStartMs !== null && request.promptTokens !== null) {
      prefillTokens += request.promptTokens;
      prefillMs += request.firstTokenMs - prefillStartMs;
    }
  }
  firstTokenSpans.sort((a, b) => a - b);

  return {
    decodeTokensPerSecond: ratePerSecond(decodeTokens, decodeWallMs),
    perRequestDecodeTokensPerSecond: ratePerSecond(
      perRequestTokens,
      decodeWallMs,
    ),
    soloDecodeTokensPerSecond: soloDecodeBaseline(segmentClasses),
    prefillTokensPerSecond: ratePerSecond(prefillTokens, prefillMs),
    totalPromptTokens,
    timeToFirstTokenP50Ms: percentile(firstTokenSpans, 0.5),
    timeToFirstTokenP95Ms: percentile(firstTokenSpans, 0.95),
    peakConcurrentDecode: segments.reduce(
      (peak, segment) => Math.max(peak, segment.decodeCount),
      0,
    ),
  };
}

function summarizeRequests(
  requests: readonly MeasuredRequest[],
  segments: readonly BenchmarkSegment[],
  segmentClasses: BenchmarkSegmentClass[],
  topics: BenchmarkTopicSummary[],
): BenchmarkRunSummary {
  const spans = new Map<number, { minSubmitMs: number; maxDoneMs: number }>();
  let totalCompletionTokens = 0;
  let failedRequestCount = 0;
  for (const request of requests) {
    if (request.error !== null) {
      failedRequestCount += 1;
    }
    totalCompletionTokens +=
      request.completionTokens ?? request.chunkTimesMs.length;
    if (request.doneMs === null) continue;
    const span = spans.get(request.repetition);
    if (span) {
      span.minSubmitMs = Math.min(span.minSubmitMs, request.submitMs);
      span.maxDoneMs = Math.max(span.maxDoneMs, request.doneMs);
    } else {
      spans.set(request.repetition, {
        minSubmitMs: request.submitMs,
        maxDoneMs: request.doneMs,
      });
    }
  }
  const wallMs = [...spans.values()].reduce(
    (sum, span) => sum + (span.maxDoneMs - span.minSubmitMs),
    0,
  );
  return {
    requestCount: requests.length,
    failedRequestCount,
    totalCompletionTokens,
    wallMs,
    acceptanceRate: weightedAcceptance(requests),
    headline: buildHeadline(requests, segments, segmentClasses),
    topics,
    segmentClasses,
  };
}
