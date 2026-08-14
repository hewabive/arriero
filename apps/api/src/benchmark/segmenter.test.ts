import type { BenchmarkServerTimings } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkRunResult,
  summarizeBenchmarkRunResult,
  type MeasuredRequest,
} from "./segmenter.js";

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
  const result = buildBenchmarkRunResult([
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

  const topic = result.topics[0];
  assert.equal(topic?.soloDecodeTokensPerSecond, 10);
  assert.equal(topic?.contendedDecodeTokensPerSecond, null);
  assert.equal(topic?.averageTimeToFirstTokenMs, 100);
});

test("overlapping requests classify mixed and pure-decode segments", () => {
  const result = buildBenchmarkRunResult([
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

  const mixed = result.segmentClasses.find(
    (entry) => entry.prefillCount === 1 && entry.decodeCount === 1,
  );
  assert.equal(mixed?.wallMs, 400);
  assert.equal(mixed?.decodeTokensPerSecond, 10);
  assert.equal(mixed?.perRequestDecodeTokensPerSecond, 10);

  const pureDecode = result.segmentClasses.find(
    (entry) => entry.prefillCount === 0 && entry.decodeCount === 2,
  );
  assert.equal(pureDecode?.wallMs, 400);
  assert.equal(pureDecode?.decodeTokensPerSecond, 32.5);
  assert.equal(pureDecode?.perRequestDecodeTokensPerSecond, 16.25);
  assert.equal(pureDecode?.wallShare, 400 / 1100);

  const codeTopic = result.topics.find((entry) => entry.topic === "code");
  assert.equal(codeTopic?.soloDecodeTokensPerSecond, 5);
  assert.equal(codeTopic?.contendedDecodeTokensPerSecond, 11.25);

  const ragTopic = result.topics.find((entry) => entry.topic === "rag");
  assert.equal(ragTopic?.soloDecodeTokensPerSecond, null);
  assert.equal(ragTopic?.contendedDecodeTokensPerSecond, 20);
});

test("known prompt duration separates queue wait from prefill", () => {
  const result = buildBenchmarkRunResult([
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
  const result = buildBenchmarkRunResult([
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
  const result = buildBenchmarkRunResult([
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
  const result = buildBenchmarkRunResult(requests);

  assert.equal(result.segments.length, 4);
  assert.deepEqual(
    result.segments.map((segment) => segment.repetition),
    [0, 0, 1, 1],
  );
  assert.equal(
    result.segments.every((segment) => segment.endMs - segment.startMs <= 500),
    true,
  );

  const summary = summarizeBenchmarkRunResult(requests, result);
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
  const result = buildBenchmarkRunResult(requests);

  assert.equal(result.segments.length, 2);
  assert.equal(result.requests.length, 2);
  assert.equal(
    result.requests.find((request) => request.requestId === "b")?.error,
    "upstream refused",
  );

  const summary = summarizeBenchmarkRunResult(requests, result);
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
  const result = buildBenchmarkRunResult(requests);

  assert.equal(
    result.requests.find((request) => request.requestId === "a")
      ?.acceptanceRate,
    0.8,
  );
  const summary = summarizeBenchmarkRunResult(requests, result);
  assert.equal(summary.acceptanceRate, 0.575);
});

test("speculative burst at first-token timestamp is attributed to decode", () => {
  const result = buildBenchmarkRunResult([
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
