import assert from "node:assert/strict";
import test from "node:test";

import { BenchmarkLoadCollector } from "./load-statistics.js";
import type { MeasuredRequest } from "./segmenter.js";

function request(overrides: Partial<MeasuredRequest> = {}): MeasuredRequest {
  return {
    requestId: "a",
    promptId: "short",
    topic: "code",
    language: "en",
    repetition: 0,
    submitMs: 0,
    firstTokenMs: 100,
    doneMs: 1100,
    endedMs: 1200,
    chunkTimesMs: [100, 500, 1100],
    promptTokens: 20,
    completionTokens: 6,
    serverTimings: null,
    finishReason: "stop",
    error: null,
    ...overrides,
  };
}

test("load throughput includes failed request time and uses successful output only", () => {
  const collector = new BenchmarkLoadCollector();
  collector.record(
    request({
      requestId: "c",
      submitMs: 1200,
      firstTokenMs: 1300,
      doneMs: 1600,
      endedMs: 2000,
      chunkTimesMs: [1300, 1600],
      completionTokens: 4,
    }),
  );
  collector.record(request());
  collector.record(
    request({
      requestId: "b",
      promptId: "long",
      submitMs: 400,
      firstTokenMs: null,
      doneMs: null,
      endedMs: 2400,
      chunkTimesMs: [],
      completionTokens: null,
      error: "timeout",
      timedOut: true,
    }),
  );
  const { summary, result } = collector.analyze();
  assert.equal(summary.wallMs, 2400);
  assert.equal(summary.failedRequestCount, 1);
  assert.equal(summary.load?.requestsPerSecond, 2 / 2.4);
  assert.equal(summary.load?.outputTokensPerSecond, 10 / 2.4);
  assert.equal(summary.load?.timedOutRequestCount, 1);
  assert.deepEqual(summary.load?.timeToFirstToken, {
    p50Ms: 100,
    p95Ms: 100,
    p99Ms: 100,
  });
  assert.equal(summary.load?.latency.p95Ms, 1180);
  assert.equal(summary.load?.maxChunkGapMs, 600);
  assert.deepEqual(
    result.requests.map((value) => value.requestId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    result.loadTimeline?.map((value) => value.outputTokens),
    [4, 6, 0],
  );
  assert.deepEqual(
    result.loadTimeline?.map((value) => value.averageActiveRequests),
    [1.6, 2, 1],
  );
  assert.deepEqual(
    result.loadTimeline?.map((value) => value.averageWaitingRequests),
    [0.7, 1.1, 1],
  );
  assert.deepEqual(
    result.loadTimeline?.map((value) => value.failedRequests),
    [0, 0, 1],
  );
  assert.equal(
    summary.load?.groups.find((group) => group.promptId === "long")
      ?.latencyP95Ms,
    null,
  );
});

test("missing usage leaves token throughput unknown instead of counting chunks as tokens", () => {
  const collector = new BenchmarkLoadCollector();
  collector.record(request({ completionTokens: null }));
  const { summary, result } = collector.analyze();
  assert.equal(summary.load?.outputTokensPerSecond, null);
  assert.equal(summary.load?.requestsPerSecond, 1 / 1.2);
  assert.ok(
    result.loadTimeline?.every((bucket) => bucket.outputTokens === null),
  );
});

test("long runs compact the timeline without losing tokens or completed requests", () => {
  const collector = new BenchmarkLoadCollector();
  for (let index = 0; index < 5000; index += 1) {
    const offset = index * 1200;
    collector.record(
      request({
        requestId: String(index),
        submitMs: offset,
        firstTokenMs: offset + 100,
        doneMs: offset + 1100,
        endedMs: offset + 1200,
        chunkTimesMs: [offset + 100, offset + 500, offset + 1100],
      }),
    );
  }
  const { summary, result } = collector.analyze();
  assert.equal(result.requests.length, 5000);
  assert.ok((result.loadTimeline?.length ?? Infinity) <= 600);
  assert.equal(
    result.loadTimeline?.reduce(
      (sum, bucket) => sum + (bucket.outputTokens ?? 0),
      0,
    ),
    30000,
  );
  assert.equal(
    result.loadTimeline?.reduce(
      (sum, bucket) => sum + bucket.completedRequests,
      0,
    ),
    5000,
  );
  assert.equal(summary.load?.outputTokensPerSecond, 5);
  assert.ok(
    result.loadTimeline?.every(
      (bucket) => Math.abs(bucket.averageActiveRequests - 1) < 1e-9,
    ),
  );
});

test("an output chunk exactly at the run end stays in the final bucket", () => {
  const collector = new BenchmarkLoadCollector();
  collector.record(
    request({
      firstTokenMs: 500,
      doneMs: 1000,
      endedMs: 1000,
      chunkTimesMs: [500, 1000],
      completionTokens: 2,
    }),
  );
  assert.deepEqual(
    collector
      .analyze()
      .result.loadTimeline?.map((bucket) => bucket.outputTokens),
    [2],
  );
});

test("cancellation before first output retains elapsed time and null latency percentiles", () => {
  const collector = new BenchmarkLoadCollector();
  collector.record(
    request({
      firstTokenMs: null,
      doneMs: null,
      endedMs: 1000,
      chunkTimesMs: [],
      completionTokens: null,
      error: "canceled",
    }),
  );
  const { summary } = collector.analyze();
  assert.equal(summary.wallMs, 1000);
  assert.equal(summary.load?.canceledRequestCount, 1);
  assert.equal(summary.load?.timedOutRequestCount, 0);
  assert.equal(summary.load?.timeToFirstToken.p99Ms, null);
  assert.equal(summary.load?.maxChunkGapMs, null);
});
