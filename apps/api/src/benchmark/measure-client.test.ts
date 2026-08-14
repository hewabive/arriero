import assert from "node:assert/strict";
import test from "node:test";

import { runMeasuredRequest } from "./measure-client.js";

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function tickingClock(step: number) {
  let tick = 0;
  return () => {
    tick += step;
    return tick;
  };
}

test("measures chunk arrivals and extracts usage and llama timings", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":10,"prompt_ms":50.5,"predicted_n":2,"predicted_ms":100,"draft_n":4,"draft_n_accepted":3}}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const outcome = await runMeasuredRequest({
    url: "http://upstream/v1/chat/completions",
    body: { stream: true },
    fetchImpl: async () => sseResponse(frames),
    now: tickingClock(10),
  });

  assert.equal(outcome.submitMs, 10);
  assert.deepEqual(outcome.chunkTimesMs, [20, 30]);
  assert.equal(outcome.firstTokenMs, 20);
  assert.equal(outcome.doneMs, 30);
  assert.equal(outcome.promptTokens, 10);
  assert.equal(outcome.completionTokens, 2);
  assert.equal(outcome.finishReason, "stop");
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.serverTimings, {
    promptN: 10,
    promptMs: 50.5,
    predictedN: 2,
    predictedMs: 100,
    draftN: 4,
    draftNAccepted: 3,
  });
});

test("reports upstream error status with body excerpt", async () => {
  const outcome = await runMeasuredRequest({
    url: "http://upstream/v1/chat/completions",
    body: {},
    fetchImpl: async () => new Response("model not loaded", { status: 503 }),
    now: tickingClock(10),
  });

  assert.equal(outcome.error, "upstream 503: model not loaded");
  assert.equal(outcome.firstTokenMs, null);
  assert.equal(outcome.chunkTimesMs.length, 0);
});

test("maps an aborted request to a canceled error", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runMeasuredRequest({
    url: "http://upstream/v1/chat/completions",
    body: {},
    signal: controller.signal,
    fetchImpl: async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
    now: tickingClock(10),
  });

  assert.equal(outcome.error, "canceled");
});

test("falls back to llama timings when usage is absent", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":7,"prompt_ms":20,"predicted_n":5,"predicted_ms":40}}\n\n',
    "data: [DONE]\n\n",
  ];
  const outcome = await runMeasuredRequest({
    url: "http://upstream/v1/chat/completions",
    body: {},
    fetchImpl: async () => sseResponse(frames),
    now: tickingClock(10),
  });

  assert.equal(outcome.promptTokens, 7);
  assert.equal(outcome.completionTokens, 5);
  assert.equal(outcome.serverTimings?.draftN, null);
});

test("flags malformed stream frames while keeping measured chunks", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: {broken\n\n",
    "data: [DONE]\n\n",
  ];
  const outcome = await runMeasuredRequest({
    url: "http://upstream/v1/chat/completions",
    body: {},
    fetchImpl: async () => sseResponse(frames),
    now: tickingClock(10),
  });

  assert.equal(outcome.error, "1 malformed stream frames");
  assert.equal(outcome.chunkTimesMs.length, 1);
});
