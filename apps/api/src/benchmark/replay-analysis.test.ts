import assert from "node:assert/strict";
import test from "node:test";

import type {
  BenchmarkRequestResult,
  WorkloadDatasetRecord,
  WorkloadDatasetSegment,
} from "@arriero/core";

import { analyzeReplayRequests, replayRequestId } from "./replay-analysis.js";

function record(input: {
  traceId: string;
  promptTokens: number | null;
  cacheReadTokens: number | null;
  targetName?: string | null;
}): WorkloadDatasetRecord {
  return {
    traceId: input.traceId,
    protocol: "anthropic",
    endpoint: "messages",
    routePath: "/v1/messages",
    offsetMs: 0,
    thinkTimeMs: null,
    durationMs: 1000,
    outcome: "success",
    targetName: input.targetName === undefined ? "local" : input.targetName,
    promptTokens: input.promptTokens,
    cacheReadTokens: input.cacheReadTokens,
    completionTokens: 50,
    ttftMs: null,
    body: { fields: {}, messages: [], tools: null, system: null },
  };
}

function result(input: {
  segmentIndex: number;
  recordIndex: number;
  submitMs: number;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  error?: string;
}): BenchmarkRequestResult {
  const firstTokenMs = input.submitMs + 100;
  return {
    requestId: replayRequestId(input),
    promptId: "session",
    topic: `segment ${input.segmentIndex + 1}`,
    language: `turn ${input.recordIndex + 1}`,
    repetition: 0,
    submitMs: input.submitMs,
    prefillStartMs: null,
    firstTokenMs: input.error ? null : firstTokenMs,
    doneMs: input.error ? null : firstTokenMs + 1000,
    endedMs: firstTokenMs + 1000,
    timedOut: false,
    maxChunkGapMs: null,
    chunkCount: 10,
    promptTokens: input.promptTokens,
    cachedPromptTokens: input.cachedPromptTokens,
    completionTokens: 40,
    clientDecodeTokensPerSecond: input.error ? null : 40,
    serverTimings: {
      promptN: null,
      promptMs: null,
      predictedN: null,
      predictedMs: null,
      draftN: 20,
      draftNAccepted: 15,
    },
    acceptanceRate: 0.75,
    finishReason: input.error ? null : "stop",
    error: input.error ?? null,
  };
}

const segments: WorkloadDatasetSegment[] = [
  {
    sessionId: "primed-session",
    windowIndex: 0,
    sourceName: null,
    modelId: "m",
    priming: record({ traceId: "p", promptTokens: 1000, cacheReadTokens: 0 }),
    primingEndedAt: null,
    records: [
      record({ traceId: "a", promptTokens: 1500, cacheReadTokens: 1200 }),
      record({
        traceId: "b",
        promptTokens: 2000,
        cacheReadTokens: 1900,
        targetName: "elsewhere",
      }),
    ],
  },
  {
    sessionId: "cold-session",
    windowIndex: 0,
    sourceName: null,
    modelId: "m",
    priming: null,
    primingEndedAt: null,
    records: [
      record({ traceId: "c", promptTokens: 800, cacheReadTokens: null }),
      record({ traceId: "d", promptTokens: 900, cacheReadTokens: 700 }),
    ],
  },
];

const requests = [
  result({
    segmentIndex: 0,
    recordIndex: 0,
    submitMs: 0,
    promptTokens: 1500,
    cachedPromptTokens: 1000,
  }),
  result({
    segmentIndex: 0,
    recordIndex: 1,
    submitMs: 2000,
    promptTokens: 2000,
    cachedPromptTokens: 1500,
  }),
  result({
    segmentIndex: 1,
    recordIndex: 0,
    submitMs: 500,
    promptTokens: 800,
    cachedPromptTokens: 0,
  }),
  result({
    segmentIndex: 1,
    recordIndex: 1,
    submitMs: 3000,
    promptTokens: null,
    cachedPromptTokens: null,
    error: "upstream 500",
  }),
];

test("segments summarize their successful requests", () => {
  const { summary } = analyzeReplayRequests({
    segments,
    primedSegments: new Set([0]),
    requests,
    recordedArrival: false,
  });
  assert.equal(summary.fidelity, null);
  const [primed, cold] = summary.segments;
  assert.equal(primed?.primed, true);
  assert.equal(primed?.requestCount, 2);
  assert.equal(primed?.promptTokens, 3500);
  assert.equal(primed?.cachedPromptTokens, 2500);
  assert.equal(primed?.completionTokens, 80);
  assert.equal(primed?.timeToFirstTokenP50Ms, 100);
  assert.equal(primed?.decodeTokensPerSecond, 40);
  assert.equal(primed?.acceptanceRate, 0.75);
  assert.equal(primed?.wallMs, 3100);
  assert.equal(cold?.primed, false);
  assert.equal(cold?.failedRequestCount, 1);
  assert.equal(cold?.promptTokens, 800);
});

test("the recorded plan reports fidelity with the response reuse replay cannot repeat", () => {
  const { summary, fidelity } = analyzeReplayRequests({
    segments,
    primedSegments: new Set([0]),
    requests,
    recordedArrival: true,
  });
  assert.deepEqual(
    fidelity?.map((row) => [row.traceId, row.responseReuseTokens]),
    [
      ["a", 200],
      ["b", null],
      ["c", null],
    ],
  );
  assert.deepEqual(summary.fidelity, {
    comparedRequestCount: 2,
    uncomparedRequestCount: 1,
    recordedPromptTokens: 3500,
    recordedCachedPromptTokens: 3100,
    replayedPromptTokens: 3500,
    replayedCachedPromptTokens: 2500,
    responseReuseTokens: 200,
  });
});
