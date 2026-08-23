import assert from "node:assert/strict";
import { test } from "node:test";

import { anthropicResumableCodec } from "./anthropic.js";
import { openAiResumableCodec } from "./openai.js";
import {
  consumeResumableSse,
  createResumableBufferState,
  finalFromState,
  runResumableForward,
  runResumableUpstreamAttempt,
} from "./resumable-forward.js";

const codec = openAiResumableCodec;

function anthropicEvent(type: string, payload: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function chunkFrame(input: {
  content?: string;
  finish?: string;
  id?: string;
  model?: string;
}) {
  return `data: ${JSON.stringify({
    id: input.id ?? "cmpl",
    model: input.model ?? "m",
    choices: [
      {
        delta: input.content === undefined ? {} : { content: input.content },
        finish_reason: input.finish ?? null,
      },
    ],
  })}\n\n`;
}

function makeFetch(frames: string[], options: { hang?: boolean } = {}) {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        if (!options.hang) {
          controller.close();
          return;
        }
        if (signal?.aborted) {
          controller.error(new Error("aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => controller.error(new Error("aborted")),
          { once: true },
        );
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function usageFrame(input: { prompt: number; completion: number }) {
  return `data: ${JSON.stringify({
    id: "cmpl",
    model: "m",
    choices: [],
    usage: { prompt_tokens: input.prompt, completion_tokens: input.completion },
  })}\n\n`;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("openAiResumableCodec.upstreamBody forces stream and appends prefill", () => {
  const first = openAiResumableCodec.upstreamBody(
    { messages: [{ role: "user", content: "hi" }], stream: false },
    null,
  ) as Record<string, unknown>;
  assert.equal(first.stream, true);
  assert.equal((first.messages as unknown[]).length, 1);

  const resumed = openAiResumableCodec.upstreamBody(
    { messages: [{ role: "user", content: "hi" }] },
    "so far",
  ) as Record<string, unknown>;
  const messages = resumed.messages as Array<Record<string, unknown>>;
  assert.equal(resumed.stream, true);
  assert.deepEqual(messages[messages.length - 1], {
    role: "assistant",
    content: "so far",
  });
});

test("openAiResumableCodec.parseChunk reads deltas, done and junk", () => {
  assert.equal(openAiResumableCodec.parseChunk("[DONE]"), "done");
  assert.equal(openAiResumableCodec.parseChunk("not json"), "malformed");
  assert.equal(openAiResumableCodec.parseChunk('"just a string"'), "malformed");
  assert.deepEqual(
    openAiResumableCodec.parseChunk(
      JSON.stringify({
        id: "x",
        model: "m",
        choices: [{ delta: { content: "hey" }, finish_reason: "stop" }],
      }),
    ),
    { text: "hey", finishReason: "stop", id: "x", model: "m", phase: "text" },
  );
});

test("parseChunk extracts usage from a usage-only chunk", () => {
  assert.deepEqual(
    openAiResumableCodec.parseChunk(
      JSON.stringify({
        id: "x",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    ),
    {
      text: "",
      finishReason: null,
      id: "x",
      model: "m",
      usage: { promptTokens: 12, cacheReadTokens: null, completionTokens: 7 },
    },
  );
});

test("parseChunk reads upstream predicted_ms timing as genMs", () => {
  assert.deepEqual(
    openAiResumableCodec.parseChunk(
      JSON.stringify({
        id: "x",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
        timings: { predicted_ms: 1900.6, predicted_per_second: 3.68 },
      }),
    ),
    {
      text: "",
      finishReason: null,
      id: "x",
      model: "m",
      genMs: 1901,
      usage: { promptTokens: 12, cacheReadTokens: null, completionTokens: 7 },
    },
  );
});

test("runResumableUpstreamAttempt leaves genMs at zero without upstream timing", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      chunkFrame({ content: "Hel" }),
      chunkFrame({ content: "lo", finish: "stop" }),
      usageFrame({ prompt: 10, completion: 5 }),
      "data: [DONE]\n\n",
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.text, "Hello");
  assert.equal(state.completionTokens, 5);
  assert.equal(state.promptTokens, 10);
  assert.equal(state.genMs, 0);
});

test("runResumableUpstreamAttempt reads upstream predicted_ms as genMs", async () => {
  const state = createResumableBufferState();
  const usageWithTimings = `data: ${JSON.stringify({
    id: "cmpl",
    model: "m",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    timings: { predicted_ms: 250, predicted_per_second: 20 },
  })}\n\n`;
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      chunkFrame({ content: "Hel" }),
      chunkFrame({ content: "lo", finish: "stop" }),
      usageWithTimings,
      "data: [DONE]\n\n",
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.completionTokens, 5);
  assert.equal(state.genMs, 250);
});

test("completion tokens accumulate across resume rounds", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      if (attempts === 1) {
        state.text = "AB";
        state.completionTokens += 2;
        return { type: "preempted" };
      }
      state.text = "ABCD";
      state.completionTokens += 3;
      state.promptTokens = 9;
      state.genMs = 500;
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(state.completionTokens, 5);
});

test("finalResponse emits usage and proxy-computed effective tok/s", () => {
  const final = openAiResumableCodec.finalResponse({
    text: "hello",
    id: "x",
    model: "m",
    finishReason: "stop",
    wantsStream: false,
    completionTokens: 5,
    promptTokens: 10,
    genMs: 1000,
  });
  const body = JSON.parse(final.body);
  assert.deepEqual(body.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
  assert.equal(body.timings.predicted_n, 5);
  assert.equal(body.timings.predicted_per_second, 5);
});

test("finalResponse omits usage/timings when no tokens were counted", () => {
  const final = openAiResumableCodec.finalResponse({
    text: "x",
    id: null,
    model: null,
    finishReason: null,
    wantsStream: false,
  });
  const body = JSON.parse(final.body);
  assert.equal(body.usage, undefined);
  assert.equal(body.timings, undefined);
});

test("runResumableUpstreamAttempt counts malformed payloads without dropping the stream", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      chunkFrame({ content: "Hel" }),
      "data: {broken json\n\n",
      chunkFrame({ content: "lo", finish: "stop" }),
      "data: [DONE]\n\n",
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.text, "Hello");
  assert.equal(state.health.malformedChunks, 1);
  assert.equal(state.health.malformedSample, "{broken json");
});

test("runResumableUpstreamAttempt accumulates a completed stream", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      chunkFrame({ content: "Hel" }),
      chunkFrame({ content: "lo", finish: "stop" }),
      "data: [DONE]\n\n",
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.text, "Hello");
  assert.equal(state.finishReason, "stop");
});

test("runResumableUpstreamAttempt accumulates an Anthropic stream with usage", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec: anthropicResumableCodec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      anthropicEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "m", usage: { input_tokens: 5 } },
      }),
      anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      }),
      anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      }),
      anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      }),
      anthropicEvent("message_stop", { type: "message_stop" }),
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.text, "Hello");
  assert.equal(state.finishReason, "end_turn");
  assert.equal(state.completionTokens, 7);
  assert.equal(state.promptTokens, 5);
});

test("runResumableUpstreamAttempt returns preempted before fetching", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: controller.signal,
    fetchImpl: makeFetch([]),
  });
  assert.equal(outcome.type, "preempted");
});

test("runResumableUpstreamAttempt classifies a consumer abort with a string reason", async () => {
  const consumer = new AbortController();
  consumer.abort("Client connection prematurely closed.");
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    consumerSignal: consumer.signal,
    fetchImpl: makeFetch([]),
  });
  assert.equal(outcome.type, "consumer-gone");
});

test("runResumableUpstreamAttempt reports a non-Error fetch rejection as its text", async () => {
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    fetchImpl: (async () => {
      throw "socket hang up";
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(outcome, { type: "error", message: "socket hang up" });
});

test("runResumableUpstreamAttempt captures partial text then preempts", async () => {
  const state = createResumableBufferState();
  const preempt = new AbortController();
  const pending = runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: preempt.signal,
    fetchImpl: makeFetch([chunkFrame({ content: "partial" })], { hang: true }),
  });

  await flush();
  preempt.abort();
  const outcome = await pending;

  assert.equal(outcome.type, "preempted");
  assert.equal(state.text, "partial");
});

test("runResumableForward returns a synthesized non-stream response", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      state.text = "done-text";
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(attempts, 1);
  assert.equal(final.headers["content-type"], "application/json");
  assert.equal(JSON.parse(final.body).choices[0].message.content, "done-text");
});

test("runResumableForward signals a gone consumer with the client-abort status", async () => {
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => ({ type: "consumer-gone" }),
    state: createResumableBufferState(),
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(final.status, 499);
  assert.equal(final.body, "");
});

test("runResumableForward resumes with the accumulated tail after preemption", async () => {
  const state = createResumableBufferState();
  const tails: Array<string | null> = [];
  let yields = 0;
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async (tail) => {
      tails.push(tail);
      attempts += 1;
      if (attempts === 1) {
        state.text = "AB";
        return { type: "preempted" };
      }
      state.text = "ABCD";
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => {
      yields += 1;
    },
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.deepEqual(tails, [null, "AB"]);
  assert.equal(yields, 1);
  assert.equal(JSON.parse(final.body).choices[0].message.content, "ABCD");
});

function toolFrame(tool: { id?: string; name?: string; arguments?: string }) {
  const fn: Record<string, string> = {};
  if (tool.name !== undefined) {
    fn.name = tool.name;
  }
  if (tool.arguments !== undefined) {
    fn.arguments = tool.arguments;
  }
  return `data: ${JSON.stringify({
    id: "cmpl",
    model: "m",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(tool.id !== undefined ? { id: tool.id } : {}),
              function: fn,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

test("runResumableUpstreamAttempt defers preemption during a tool call", async () => {
  const state = createResumableBufferState();
  const preempt = new AbortController();
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const fetchImpl = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode(toolFrame({ id: "call_1", name: "get_weather" })),
        );
        controller.enqueue(
          encoder.encode(toolFrame({ arguments: '{"city":"Moscow"}' })),
        );
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  const pending = runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: preempt.signal,
    fetchImpl,
  });

  await flush();
  assert.equal(state.inToolPhase, true);
  preempt.abort();
  await flush();

  const controller =
    streamController as ReadableStreamDefaultController<Uint8Array> | null;
  assert.notEqual(controller, null);
  controller!.enqueue(encoder.encode("data: [DONE]\n\n"));
  controller!.close();
  const outcome = await pending;

  assert.equal(outcome.type, "completed");
  assert.deepEqual(state.toolCalls.filter(Boolean), [
    { id: "call_1", name: "get_weather", arguments: '{"city":"Moscow"}' },
  ]);
});

test("runResumableUpstreamAttempt forwards tool-call deltas via onToolCall", async () => {
  const deltas: Array<{
    index: number;
    id?: string | undefined;
    name?: string | undefined;
    arguments?: string | undefined;
  }> = [];
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    onToolCall: (delta) => deltas.push(delta),
    fetchImpl: makeFetch([
      toolFrame({ id: "call_1", name: "get_weather" }),
      toolFrame({ arguments: '{"city":"Moscow"}' }),
      chunkFrame({ finish: "tool_calls" }),
      "data: [DONE]\n\n",
    ]),
  });
  assert.equal(outcome.type, "completed");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.name, "get_weather");
  assert.equal(deltas[1]?.arguments, '{"city":"Moscow"}');
});

test("runResumableUpstreamAttempt reports truncated on EOF without a terminal", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([chunkFrame({ content: "cut off mid-answ" })]),
  });

  assert.equal(outcome.type, "truncated");
  assert.equal(state.text, "cut off mid-answ");
  assert.equal(state.health.terminal, "eof");
});

test("runResumableUpstreamAttempt accepts a finish_reason terminal without [DONE]", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      chunkFrame({ content: "Hi" }),
      chunkFrame({ finish: "stop" }),
      usageFrame({ prompt: 3, completion: 2 }),
    ]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.health.terminal, "finish");
  assert.equal(state.completionTokens, 2);
});

test("runResumableUpstreamAttempt accepts [DONE] without any finish_reason", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([chunkFrame({ content: "Hi" }), "data: [DONE]\n\n"]),
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.health.terminal, "done");
});

test("runResumableUpstreamAttempt reports a truncated Anthropic stream", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec: anthropicResumableCodec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      anthropicEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "m", usage: { input_tokens: 5 } },
      }),
      anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      }),
    ]),
  });

  assert.equal(outcome.type, "truncated");
  assert.equal(state.text, "partial");
  assert.equal(state.health.terminal, "eof");
});

test("runResumableUpstreamAttempt errors when the upstream stream stalls", async () => {
  const state = createResumableBufferState();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state,
    preemptSignal: new AbortController().signal,
    idleTimeoutMs: 30,
    fetchImpl: makeFetch([chunkFrame({ content: "before the stall" })], {
      hang: true,
    }),
  });

  assert.equal(outcome.type, "error");
  assert.match(
    (outcome as { type: "error"; message: string }).message,
    /stalled/,
  );
  assert.equal(state.text, "before the stall");
});

test("runResumableForward resumes with the tail after a truncation and records the retry", async () => {
  const state = createResumableBufferState();
  const tails: Array<string | null> = [];
  let attempts = 0;
  let yields = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async (tail) => {
      tails.push(tail);
      attempts += 1;
      if (attempts === 1) {
        state.text = "AB";
        state.health.terminal = "eof";
        return { type: "truncated" };
      }
      state.text = "ABCD";
      state.finishReason = "stop";
      state.health.terminal = "done";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => {
      yields += 1;
    },
    wantsStream: false,
    truncation: { mode: "resume" },
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.deepEqual(tails, [null, "AB"]);
  assert.equal(yields, 0);
  assert.equal(state.health.truncationRetries, 1);
  assert.equal(JSON.parse(final.body).choices[0].message.content, "ABCD");
});

test("runResumableForward accept mode finalizes a truncated buffer", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      state.text = "partial";
      state.health.terminal = "eof";
      return { type: "truncated" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    truncation: { mode: "accept" },
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(attempts, 1);
  assert.equal(final.status, 200);
  assert.equal(JSON.parse(final.body).choices[0].message.content, "partial");
  assert.equal(state.health.truncationRetries, 0);
});

test("runResumableForward error mode rejects a truncated stream without retrying", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      state.text = "partial";
      return { type: "truncated" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    truncation: { mode: "error" },
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(attempts, 1);
  assert.equal(final.status, 502);
  assert.match(final.body, /ended without a terminal chunk/);
});

test("runResumableForward caps truncation retries and then errors", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      state.text += "x";
      return { type: "truncated" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    truncation: { mode: "resume" },
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(attempts, 3);
  assert.equal(final.status, 502);
  assert.match(final.body, /2 resume retries/);
});

test("runResumableForward defaults to accepting truncated streams", async () => {
  const state = createResumableBufferState();
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      state.text = "legacy";
      return { type: "truncated" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(final.status, 200);
  assert.equal(JSON.parse(final.body).choices[0].message.content, "legacy");
});

test("runResumableForward regenerates from scratch when preempted before any text", async () => {
  const state = createResumableBufferState();
  const tails: Array<string | null> = [];
  let attempts = 0;
  await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async (tail) => {
      tails.push(tail);
      attempts += 1;
      if (attempts === 1) {
        return { type: "preempted" };
      }
      state.text = "answer";
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.deepEqual(tails, [null, null]);
});

test("runResumableForward forces an answer after an interrupt, preserving reasoning", async () => {
  const state = createResumableBufferState();
  const tails: Array<string | null> = [];
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async (tail) => {
      tails.push(tail);
      attempts += 1;
      if (attempts === 1) {
        state.reasoningText = "R";
        return { type: "interrupted" };
      }
      if (attempts === 2) {
        state.text = "AB";
        return { type: "preempted" };
      }
      state.text = "ABCD";
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
    buildForceAnswerTail: (reasoning) => `<think>\n${reasoning}\n</think>\n\n`,
  });

  assert.deepEqual(tails, [
    null,
    "<think>\nR\n</think>\n\n",
    "<think>\nR\n</think>\n\nAB",
  ]);
  assert.equal(state.reasoningText, "R");
  const body = JSON.parse(final.body);
  assert.equal(body.choices[0].message.content, "ABCD");
  assert.equal(body.choices[0].message.reasoning_content, "R");
});

test("runResumableUpstreamAttempt returns interrupted when its signal aborts", async () => {
  const interrupt = new AbortController();
  interrupt.abort();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    interruptSignal: interrupt.signal,
    fetchImpl: makeFetch([]),
  });
  assert.equal(outcome.type, "interrupted");
});

test("runResumableUpstreamAttempt returns finished when its signal aborts", async () => {
  const finish = new AbortController();
  finish.abort();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    finishSignal: finish.signal,
    fetchImpl: makeFetch([]),
  });
  assert.equal(outcome.type, "finished");
});

test("runResumableUpstreamAttempt returns cancelled when its signal aborts", async () => {
  const cancel = new AbortController();
  cancel.abort();
  const outcome = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: {},
    codec,
    state: createResumableBufferState(),
    preemptSignal: new AbortController().signal,
    cancelSignal: cancel.signal,
    fetchImpl: makeFetch([]),
  });
  assert.equal(outcome.type, "cancelled");
});

test("runResumableForward returns the buffered answer when finished", async () => {
  const state = createResumableBufferState();
  state.text = "partial-answer";
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => ({ type: "finished" }),
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(final.status, 200);
  assert.match(final.body, /partial-answer/);
});

test("runResumableForward returns the client-abort status when cancelled", async () => {
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => ({ type: "cancelled" }),
    state: createResumableBufferState(),
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(final.status, 499);
  assert.equal(final.body, "");
});

test("runResumableForward returns the readiness failure response", async () => {
  const final = await runResumableForward({
    makeReady: async () => ({
      ok: false,
      final: { status: 503, headers: {}, body: "nope" },
    }),
    attempt: async () => ({ type: "completed" }),
    state: createResumableBufferState(),
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });
  assert.equal(final.status, 503);
  assert.equal(final.body, "nope");
});

test("runResumableForward caps resume attempts and emits the partial buffer", async () => {
  const state = createResumableBufferState();
  let attempts = 0;
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      attempts += 1;
      state.text = "partial";
      return { type: "preempted" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: false,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
    maxAttempts: 3,
  });

  assert.equal(attempts, 3);
  assert.equal(JSON.parse(final.body).choices[0].message.content, "partial");
});

function streamOf(frames: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

test("consumeResumableSse buffers a stream and fires live callbacks", async () => {
  const state = createResumableBufferState();
  const deltas: string[] = [];
  const progress: number[] = [];
  let firstTokenPrompt: number | null | undefined;
  const outcome = await consumeResumableSse({
    body: streamOf([
      chunkFrame({ content: "Hel" }),
      chunkFrame({ content: "lo", finish: "stop" }),
      `data: ${JSON.stringify({
        id: "cmpl",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        timings: { predicted_ms: 250 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
    codec,
    state,
    onAnswerDelta: (text) => deltas.push(text),
    onProgress: (n) => progress.push(n),
    onFirstToken: (prompt) => {
      firstTokenPrompt = prompt;
    },
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.text, "Hello");
  assert.equal(state.finishReason, "stop");
  assert.equal(state.completionTokens, 5);
  assert.equal(state.promptTokens, 10);
  assert.equal(state.genMs, 250);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(progress.at(-1), 5);
  assert.equal(firstTokenPrompt, null);
});

test("consumeResumableSse rebuilds a non-stream response via finalFromState", async () => {
  const state = createResumableBufferState();
  await consumeResumableSse({
    body: streamOf([
      chunkFrame({ content: "Hi", id: "x", model: "m" }),
      chunkFrame({ finish: "stop" }),
      usageFrame({ prompt: 4, completion: 2 }),
      "data: [DONE]\n\n",
    ]),
    codec,
    state,
  });
  const final = finalFromState(codec, state, false);
  assert.equal(final.headers["content-type"], "application/json");
  const body = JSON.parse(final.body);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hi");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
});

test("consumeResumableSse reports truncated on EOF without a terminal", async () => {
  const state = createResumableBufferState();
  const outcome = await consumeResumableSse({
    body: streamOf([chunkFrame({ content: "partial" })]),
    codec,
    state,
  });

  assert.equal(outcome.type, "truncated");
  assert.equal(state.text, "partial");
  assert.equal(state.health.terminal, "eof");
});

test("consumeResumableSse accepts a finish_reason terminal without [DONE]", async () => {
  const state = createResumableBufferState();
  const outcome = await consumeResumableSse({
    body: streamOf([
      chunkFrame({ content: "Hi" }),
      chunkFrame({ finish: "stop" }),
    ]),
    codec,
    state,
  });

  assert.equal(outcome.type, "completed");
  assert.equal(state.health.terminal, "finish");
});

test("consumeResumableSse returns consumer-gone when the client aborts", async () => {
  const consumer = new AbortController();
  consumer.abort();
  const outcome = await consumeResumableSse({
    body: streamOf([chunkFrame({ content: "x" })]),
    codec,
    state: createResumableBufferState(),
    consumerSignal: consumer.signal,
  });
  assert.equal(outcome.type, "consumer-gone");
});

test("consumeResumableSse reports a read error as an error outcome", async () => {
  const outcome = await consumeResumableSse({
    body: new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("boom");
      },
    }),
    codec,
    state: createResumableBufferState(),
  });
  assert.deepEqual(outcome, { type: "error", message: "boom" });
});

test("runResumableForward emits an SSE body for streaming consumers", async () => {
  const state = createResumableBufferState();
  const final = await runResumableForward({
    makeReady: async () => ({ ok: true }),
    attempt: async () => {
      state.text = "hi";
      state.finishReason = "stop";
      return { type: "completed" };
    },
    state,
    codec,
    yieldLease: async () => undefined,
    wantsStream: true,
    onError: (message) => ({ status: 502, headers: {}, body: message }),
  });

  assert.equal(final.headers["content-type"], "text/event-stream");
  assert.match(final.body, /data: \[DONE\]/);
  assert.match(final.body, /"content":"hi"/);
});
