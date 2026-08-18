import type { BenchmarkServerTimings } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBenchmarkRun, type MeasuredRequest } from "./segmenter.js";

function measured(
  input: Partial<MeasuredRequest> & { requestId: string },
): MeasuredRequest {
  return {
    promptId: "prompt",
    topic: "code",
    language: "en",
    repetition: 0,
    submitMs: 0,
    firstTokenMs: null,
    doneMs: null,
    chunkTimesMs: [],
    promptTokens: null,
    completionTokens: null,
    serverTimings: null,
    finishReason: null,
    error: null,
    ...input,
  };
}

function timings(
  input: Partial<BenchmarkServerTimings>,
): BenchmarkServerTimings {
  return {
    promptN: null,
    promptMs: null,
    predictedN: null,
    predictedMs: null,
    draftN: null,
    draftNAccepted: null,
    ...input,
  };
}

test("single request splits prefill and decode segments", () => {
  const { result, summary } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 600,
      chunkTimesMs: [100, 200, 300, 400, 500, 600],
      completionTokens: 6,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  assert.equal(result.segments.length, 2);
  const [prefill, decode] = result.segments;
  assert.deepEqual(prefill, {
    repetition: 0,
    startMs: 0,
    endMs: 100,
    prefillCount: 1,
    decodeCount: 0,
    decodeTokens: 0,
    decodeTokensPerSecond: 0,
  });
  assert.deepEqual(decode, {
    repetition: 0,
    startMs: 100,
    endMs: 600,
    prefillCount: 0,
    decodeCount: 1,
    decodeTokens: 5,
    decodeTokensPerSecond: 10,
  });

  const request = result.requests[0];
  assert.equal(request?.prefillStartMs, 0);
  assert.equal(request?.clientDecodeTokensPerSecond, 10);
  assert.equal(request?.chunkCount, 6);

  const topic = summary.topics[0];
  assert.equal(topic?.soloDecodeTokensPerSecond, 10);
  assert.equal(topic?.contendedDecodeTokensPerSecond, null);
  assert.equal(topic?.averageTimeToFirstTokenMs, 100);
});

test("overlapping requests classify mixed and pure-decode segments", () => {
  const { result, summary } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      topic: "code",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 1100,
      chunkTimesMs: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
      completionTokens: 11,
      serverTimings: timings({ promptMs: 100 }),
    }),
    measured({
      requestId: "b",
      topic: "rag",
      submitMs: 300,
      firstTokenMs: 700,
      doneMs: 1100,
      chunkTimesMs: [700, 800, 900, 1000, 1100],
      completionTokens: 10,
      serverTimings: timings({ promptMs: 400 }),
    }),
  ]);

  assert.deepEqual(
    result.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      prefillCount: segment.prefillCount,
      decodeCount: segment.decodeCount,
      decodeTokens: segment.decodeTokens,
    })),
    [
      {
        startMs: 0,
        endMs: 100,
        prefillCount: 1,
        decodeCount: 0,
        decodeTokens: 0,
      },
      {
        startMs: 100,
        endMs: 300,
        prefillCount: 0,
        decodeCount: 1,
        decodeTokens: 1,
      },
      {
        startMs: 300,
        endMs: 700,
        prefillCount: 1,
        decodeCount: 1,
        decodeTokens: 4,
      },
      {
        startMs: 700,
        endMs: 1100,
        prefillCount: 0,
        decodeCount: 2,
        decodeTokens: 13,
      },
    ],
  );

  const mixed = summary.segmentClasses.find(
    (entry) => entry.prefillCount === 1 && entry.decodeCount === 1,
  );
  assert.equal(mixed?.wallMs, 400);
  assert.equal(mixed?.decodeTokensPerSecond, 10);
  assert.equal(mixed?.perRequestDecodeTokensPerSecond, 10);

  const pureDecode = summary.segmentClasses.find(
    (entry) => entry.prefillCount === 0 && entry.decodeCount === 2,
  );
  assert.equal(pureDecode?.wallMs, 400);
  assert.equal(pureDecode?.decodeTokensPerSecond, 32.5);
  assert.equal(pureDecode?.perRequestDecodeTokensPerSecond, 16.25);
  assert.equal(pureDecode?.wallShare, 400 / 1100);

  const codeTopic = summary.topics.find((entry) => entry.topic === "code");
  assert.equal(codeTopic?.soloDecodeTokensPerSecond, 5);
  assert.equal(codeTopic?.contendedDecodeTokensPerSecond, 11.25);

  const ragTopic = summary.topics.find((entry) => entry.topic === "rag");
  assert.equal(ragTopic?.soloDecodeTokensPerSecond, null);
  assert.equal(ragTopic?.contendedDecodeTokensPerSecond, 20);
});

test("known prompt duration separates queue wait from prefill", () => {
  const { result } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 500,
      doneMs: 700,
      chunkTimesMs: [500, 600, 700],
      completionTokens: 3,
      serverTimings: timings({ promptMs: 200 }),
    }),
  ]);

  assert.equal(result.requests[0]?.prefillStartMs, 300);
  assert.equal(result.segments[0]?.startMs, 300);
  assert.equal(result.segments[0]?.endMs, 500);
  assert.equal(result.segments[0]?.prefillCount, 1);
});

test("unknown prompt duration merges queue into prefill from submit", () => {
  const { result } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 100,
      firstTokenMs: 500,
      doneMs: 700,
      chunkTimesMs: [500, 600, 700],
      completionTokens: 3,
    }),
  ]);

  assert.equal(result.requests[0]?.prefillStartMs, null);
  assert.equal(result.segments[0]?.startMs, 100);
  assert.equal(result.segments[0]?.endMs, 500);
  assert.equal(result.segments[0]?.prefillCount, 1);
});

test("chunk calibration distributes usage tokens over chunks", () => {
  const { result } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 1000,
      chunkTimesMs: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
      completionTokens: 20,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  assert.equal(result.requests[0]?.clientDecodeTokensPerSecond, 20);
  assert.equal(result.segments[1]?.decodeTokens, 18);
});

test("repetitions segment independently and sum wall time", () => {
  const requests = [
    measured({
      requestId: "a0",
      repetition: 0,
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 600,
      chunkTimesMs: [100, 200, 300, 400, 500, 600],
      completionTokens: 6,
      serverTimings: timings({ promptMs: 100 }),
    }),
    measured({
      requestId: "a1",
      repetition: 1,
      submitMs: 2000,
      firstTokenMs: 2100,
      doneMs: 2600,
      chunkTimesMs: [2100, 2200, 2300, 2400, 2500, 2600],
      completionTokens: 6,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ];
  const { result, summary } = analyzeBenchmarkRun(requests);

  assert.equal(result.segments.length, 4);
  assert.deepEqual(
    result.segments.map((segment) => segment.repetition),
    [0, 0, 1, 1],
  );
  assert.equal(
    result.segments.every((segment) => segment.endMs - segment.startMs <= 500),
    true,
  );

  assert.equal(summary.wallMs, 1200);
  assert.equal(summary.totalCompletionTokens, 12);
});

test("failed request is excluded from segments but counted in summary", () => {
  const requests = [
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 600,
      chunkTimesMs: [100, 200, 300, 400, 500, 600],
      completionTokens: 6,
      serverTimings: timings({ promptMs: 100 }),
    }),
    measured({
      requestId: "b",
      submitMs: 50,
      error: "upstream refused",
    }),
  ];
  const { result, summary } = analyzeBenchmarkRun(requests);

  assert.equal(result.segments.length, 2);
  assert.equal(result.requests.length, 2);
  assert.equal(
    result.requests.find((request) => request.requestId === "b")?.error,
    "upstream refused",
  );

  assert.equal(summary.requestCount, 2);
  assert.equal(summary.failedRequestCount, 1);
});

test("acceptance rate aggregates weighted by drafted tokens", () => {
  const requests = [
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 200,
      chunkTimesMs: [100, 200],
      completionTokens: 2,
      serverTimings: timings({
        promptMs: 100,
        draftN: 100,
        draftNAccepted: 80,
      }),
    }),
    measured({
      requestId: "b",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 200,
      chunkTimesMs: [100, 200],
      completionTokens: 2,
      serverTimings: timings({
        promptMs: 100,
        draftN: 300,
        draftNAccepted: 150,
      }),
    }),
  ];
  const { result, summary } = analyzeBenchmarkRun(requests);

  assert.equal(
    result.requests.find((request) => request.requestId === "a")
      ?.acceptanceRate,
    0.8,
  );
  assert.equal(summary.acceptanceRate, 0.575);
});

test("boundary slivers do not become topic rates or a solo baseline", () => {
  const requests = [
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 1100,
      chunkTimesMs: [100, 600, 1100],
      completionTokens: 3,
      serverTimings: timings({ promptMs: 100 }),
    }),
    measured({
      requestId: "b",
      topic: "poetry",
      submitMs: 105,
      firstTokenMs: 205,
      doneMs: 1100,
      chunkTimesMs: [205, 600, 1100],
      completionTokens: 3,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ];
  const { summary } = analyzeBenchmarkRun(requests);

  const sliver = summary.segmentClasses.find(
    (entry) => entry.prefillCount === 0 && entry.decodeCount === 1,
  );
  assert.equal(sliver?.wallMs, 5);
  assert.equal(summary.headline?.soloDecodeTokensPerSecond, null);
  assert.equal(
    summary.topics.find((entry) => entry.topic === "code")
      ?.soloDecodeTokensPerSecond,
    null,
  );
});

test("a short token-dense solo decode qualifies for topic rates and the baseline", () => {
  const chunkTimesMs = Array.from(
    { length: 35 },
    (_, index) => 100 + index * 5,
  );
  const { summary } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 270,
      chunkTimesMs,
      completionTokens: 35,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  assert.equal(summary.topics[0]?.soloDecodeTokensPerSecond, 200);
  assert.equal(summary.headline?.soloDecodeTokensPerSecond, 200);
});

test("a short sparse solo decode stays unreported", () => {
  const { summary } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 270,
      chunkTimesMs: [100, 150, 210, 270],
      completionTokens: 4,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  assert.equal(summary.topics[0]?.soloDecodeTokensPerSecond, null);
  assert.equal(summary.headline?.soloDecodeTokensPerSecond, null);
});

test("the fast class floor admits a rate the stricter baseline floor rejects", () => {
  const chunkTimesMs = Array.from(
    { length: 41 },
    (_, index) => 100 + index * 3,
  );
  const { summary } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 220,
      chunkTimesMs,
      completionTokens: 41,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  const solo = summary.topics[0]?.soloDecodeTokensPerSecond;
  assert.ok(solo !== null && solo !== undefined);
  assert.ok(Math.abs(solo - 1000 / 3) < 1e-9);
  assert.equal(summary.headline?.soloDecodeTokensPerSecond, null);
});

test("headline metrics derive rates, prefill throughput and prompt tokens", () => {
  const requests = [
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 1100,
      chunkTimesMs: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
      promptTokens: 200,
      completionTokens: 11,
      serverTimings: timings({ promptMs: 100, promptN: 200 }),
    }),
  ];
  const { summary } = analyzeBenchmarkRun(requests);

  assert.equal(summary.headline?.decodeTokensPerSecond, 10);
  assert.equal(summary.headline?.perRequestDecodeTokensPerSecond, 10);
  assert.equal(summary.headline?.soloDecodeTokensPerSecond, 10);
  assert.equal(summary.headline?.prefillTokensPerSecond, 2000);
  assert.equal(summary.headline?.totalPromptTokens, 200);
  assert.equal(summary.headline?.timeToFirstTokenP50Ms, 100);
  assert.equal(summary.headline?.peakConcurrentDecode, 1);
});

test("headline percentiles interpolate and peak concurrency counts overlap", () => {
  const requests = [
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 1100,
      chunkTimesMs: [100, 400, 700, 1100],
      completionTokens: 4,
      serverTimings: timings({ promptMs: 100 }),
    }),
    measured({
      requestId: "b",
      submitMs: 400,
      firstTokenMs: 1000,
      doneMs: 1400,
      chunkTimesMs: [1000, 1200, 1400],
      completionTokens: 3,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ];
  const { summary } = analyzeBenchmarkRun(requests);

  assert.equal(summary.headline?.timeToFirstTokenP50Ms, 350);
  assert.equal(summary.headline?.timeToFirstTokenP95Ms, 575);
  assert.equal(summary.headline?.peakConcurrentDecode, 2);
  assert.equal(summary.headline?.prefillTokensPerSecond, null);
});

test("speculative burst at first-token timestamp is attributed to decode", () => {
  const { result } = analyzeBenchmarkRun([
    measured({
      requestId: "a",
      submitMs: 0,
      firstTokenMs: 100,
      doneMs: 300,
      chunkTimesMs: [100, 100, 100, 200, 300],
      completionTokens: 5,
      serverTimings: timings({ promptMs: 100 }),
    }),
  ]);

  assert.equal(result.segments[1]?.decodeTokens, 4);
});
