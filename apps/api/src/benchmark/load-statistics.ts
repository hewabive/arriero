import type {
  BenchmarkLoadBucket,
  BenchmarkLoadSummary,
  BenchmarkRequestResult,
} from "@arriero/core";

import { CANCELED_REQUEST_ERROR } from "./measure-client.js";
import {
  buildRequestResult,
  type BenchmarkRunAnalysis,
  type MeasuredRequest,
} from "./segmenter.js";

const MAX_TIMELINE_BUCKETS = 600;

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.sort((a, b) => a - b);
  const rank = (sorted.length - 1) * quantile;
  const lower = sorted[Math.floor(rank)];
  const upper = sorted[Math.ceil(rank)];
  return lower === undefined || upper === undefined
    ? null
    : lower + (upper - lower) * (rank - Math.floor(rank));
}

function percentiles(values: number[]) {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

function maxGap(requests: readonly BenchmarkRequestResult[]): number | null {
  let result: number | null = null;
  for (const request of requests) {
    if (request.maxChunkGapMs !== null)
      result = Math.max(result ?? 0, request.maxChunkGapMs);
  }
  return result;
}

function latencies(requests: readonly BenchmarkRequestResult[]) {
  const ttft: number[] = [];
  const latency: number[] = [];
  for (const request of requests) {
    if (request.error !== null) continue;
    if (request.firstTokenMs !== null)
      ttft.push(request.firstTokenMs - request.submitMs);
    if (request.endedMs !== null)
      latency.push(request.endedMs - request.submitMs);
  }
  return { ttft, latency };
}

function averageOccupancy(
  requests: readonly BenchmarkRequestResult[],
  buckets: readonly BenchmarkLoadBucket[],
  width: number,
  waiting: boolean,
): number[] {
  const partial = new Array<number>(buckets.length + 1).fill(0);
  const changes = new Array<number>(buckets.length + 1).fill(0);
  for (const request of requests) {
    const start = request.submitMs;
    const end =
      (waiting ? request.firstTokenMs : null) ?? request.endedMs ?? start;
    const first = Math.min(buckets.length, Math.floor(start / width));
    const last = Math.min(buckets.length, Math.floor(end / width));
    if (first === last) {
      partial[first] = (partial[first] ?? 0) + end - start;
    } else {
      partial[first] = (partial[first] ?? 0) + (first + 1) * width - start;
      partial[last] = (partial[last] ?? 0) + end - last * width;
      changes[first + 1] = (changes[first + 1] ?? 0) + 1;
      changes[last] = (changes[last] ?? 0) - 1;
    }
  }
  let active = 0;
  return buckets.map((bucket, index) => {
    active += changes[index] ?? 0;
    const duration = bucket.endMs - bucket.startMs;
    return duration > 0
      ? ((partial[index] ?? 0) + active * duration) / duration
      : 0;
  });
}

export class BenchmarkLoadCollector {
  readonly requests: BenchmarkRequestResult[] = [];
  private bucketMs = 1000;
  private tokens = new Map<number, number | null>();
  private endMs = 0;

  record(request: MeasuredRequest): void {
    this.requests.push(buildRequestResult(request));
    this.endMs = Math.max(
      this.endMs,
      request.endedMs ?? request.doneMs ?? request.submitMs,
    );
    while (Math.floor(this.endMs / this.bucketMs) >= MAX_TIMELINE_BUCKETS) {
      this.bucketMs *= 2;
      const merged = new Map<number, number | null>();
      for (const [index, tokens] of this.tokens) {
        const nextIndex = Math.floor(index / 2);
        const current = merged.get(nextIndex);
        merged.set(
          nextIndex,
          tokens === null || current === null ? null : (current ?? 0) + tokens,
        );
      }
      this.tokens = merged;
    }
    if (request.error !== null) return;
    const weight =
      request.completionTokens === null || request.chunkTimesMs.length === 0
        ? null
        : request.completionTokens / request.chunkTimesMs.length;
    for (const time of request.chunkTimesMs) {
      const index = Math.floor(time / this.bucketMs);
      const current = this.tokens.get(index);
      this.tokens.set(
        index,
        weight === null || current === null ? null : (current ?? 0) + weight,
      );
    }
  }

  analyze(): BenchmarkRunAnalysis {
    const requests = [...this.requests].sort((a, b) => a.submitMs - b.submitMs);
    const startMs = requests[0]?.submitMs ?? 0;
    const wallMs = this.endMs - startMs;
    const successful = requests.filter((request) => request.error === null);
    const { ttft, latency } = latencies(successful);
    const groups = new Map<string, BenchmarkRequestResult[]>();
    for (const request of requests) {
      const group = groups.get(request.promptId) ?? [];
      group.push(request);
      groups.set(request.promptId, group);
    }
    const successfulTokens = successful.every(
      (request) => request.completionTokens !== null,
    )
      ? successful.reduce(
          (sum, request) => sum + (request.completionTokens ?? 0),
          0,
        )
      : null;
    const load: BenchmarkLoadSummary = {
      successfulRequestCount: successful.length,
      timedOutRequestCount: requests.filter((request) => request.timedOut)
        .length,
      canceledRequestCount: requests.filter(
        (request) => request.error === CANCELED_REQUEST_ERROR,
      ).length,
      requestsPerSecond:
        wallMs > 0 ? (successful.length * 1000) / wallMs : null,
      outputTokensPerSecond:
        wallMs > 0 && successfulTokens !== null
          ? (successfulTokens * 1000) / wallMs
          : null,
      timeToFirstToken: percentiles(ttft),
      latency: percentiles(latency),
      maxChunkGapMs: maxGap(requests),
      groups: [...groups.entries()].map(([promptId, group]) => {
        const times = latencies(group);
        return {
          promptId,
          requestCount: group.length,
          failedRequestCount: group.filter((request) => request.error !== null)
            .length,
          timeToFirstTokenP95Ms: percentile(times.ttft, 0.95),
          latencyP95Ms: percentile(times.latency, 0.95),
          maxChunkGapMs: maxGap(group),
        };
      }),
    };
    const buckets: BenchmarkLoadBucket[] = Array.from(
      {
        length:
          requests.length > 0
            ? Math.max(1, Math.ceil(this.endMs / this.bucketMs))
            : 0,
      },
      (_, index) => ({
        startMs: index * this.bucketMs,
        endMs: Math.min((index + 1) * this.bucketMs, this.endMs),
        outputTokens: this.tokens.has(index)
          ? (this.tokens.get(index) ?? null)
          : 0,
        completedRequests: 0,
        failedRequests: 0,
        averageActiveRequests: 0,
        averageWaitingRequests: 0,
      }),
    );
    const active = averageOccupancy(requests, buckets, this.bucketMs, false);
    const waiting = averageOccupancy(requests, buckets, this.bucketMs, true);
    const lastBucket = buckets.at(-1);
    if (lastBucket && this.tokens.has(buckets.length)) {
      const boundaryTokens = this.tokens.get(buckets.length);
      lastBucket.outputTokens =
        boundaryTokens === null || lastBucket.outputTokens === null
          ? null
          : lastBucket.outputTokens + (boundaryTokens ?? 0);
    }
    for (const [index, bucket] of buckets.entries()) {
      bucket.averageActiveRequests = active[index] ?? 0;
      bucket.averageWaitingRequests = waiting[index] ?? 0;
    }
    for (const request of requests) {
      const index = Math.min(
        buckets.length - 1,
        Math.floor((request.endedMs ?? request.submitMs) / this.bucketMs),
      );
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.completedRequests += 1;
      if (request.error !== null) bucket.failedRequests += 1;
    }
    return {
      result: { requests, segments: [], loadTimeline: buckets },
      summary: {
        requestCount: requests.length,
        failedRequestCount: requests.length - successful.length,
        totalCompletionTokens: requests.reduce(
          (sum, request) =>
            sum + (request.completionTokens ?? request.chunkCount),
          0,
        ),
        wallMs,
        acceptanceRate: null,
        headline: null,
        topics: [],
        segmentClasses: [],
        load,
      },
    };
  }
}
