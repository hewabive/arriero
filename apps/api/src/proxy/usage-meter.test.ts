import assert from "node:assert/strict";
import test from "node:test";

import { anthropicResumableCodec } from "./anthropic.js";
import { openAiResponsesUsageCodec, openAiResumableCodec } from "./openai.js";
import type { ProxyPrefillProgress } from "./stream-observer.js";
import {
  createUsageMeterStream,
  includeUsageRequested,
  requestBreaksStreamReconstruction,
  returnProgressRequested,
  usageFromNonStreamBody,
  withIncludeUsage,
  withReturnProgress,
  type ProxyUsageCounts,
} from "./usage-meter.js";

test("requestBreaksStreamReconstruction flags multi-choice and logprob requests", () => {
  assert.equal(requestBreaksStreamReconstruction({ messages: [] }), false);
  assert.equal(requestBreaksStreamReconstruction({ n: 1 }), false);
  assert.equal(requestBreaksStreamReconstruction({ n: 2 }), true);
  assert.equal(requestBreaksStreamReconstruction({ logprobs: true }), true);
  assert.equal(requestBreaksStreamReconstruction({ top_logprobs: 5 }), true);
  assert.equal(requestBreaksStreamReconstruction(null), false);
});

test("usageFromNonStreamBody reads OpenAI usage and timings", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      usage: { prompt_tokens: 11, completion_tokens: 7 },
      timings: { predicted_ms: 350 },
    }),
  );
  assert.deepEqual(usage, {
    promptTokens: 11,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 7,
    genMs: 350,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("usageFromNonStreamBody reads OpenAI prompt timings", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      usage: { prompt_tokens: 11, completion_tokens: 7 },
      timings: { predicted_ms: 350, prompt_ms: 128.4, prompt_per_second: 85.6 },
    }),
  );
  assert.equal(usage?.prefillMs, 128);
  assert.equal(usage?.promptPerSecond, 85.6);
});

test("usageFromNonStreamBody rounds fractional genMs to integer", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      timings: { predicted_ms: 26.481 },
    }),
  );
  assert.equal(usage?.genMs, 26);
  assert.equal(Number.isInteger(usage?.genMs), true);
});

test("usageFromNonStreamBody reads Anthropic usage", () => {
  const usage = usageFromNonStreamBody(
    "anthropic",
    JSON.stringify({ usage: { input_tokens: 5, output_tokens: 9 } }),
  );
  assert.deepEqual(usage, {
    promptTokens: 5,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 9,
    genMs: 0,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("usageFromNonStreamBody reads Anthropic timings predicted_ms", () => {
  const usage = usageFromNonStreamBody(
    "anthropic",
    JSON.stringify({
      usage: { input_tokens: 5, output_tokens: 9 },
      timings: { predicted_ms: 1500 },
    }),
  );
  assert.equal(usage?.genMs, 1500);
});

test("usageFromNonStreamBody reads OpenAI cached prompt tokens", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      usage: {
        prompt_tokens: 53,
        completion_tokens: 51,
        prompt_tokens_details: { cached_tokens: 52 },
      },
    }),
  );
  assert.equal(usage?.promptTokens, 53);
  assert.equal(usage?.cacheReadTokens, 52);
  assert.equal(usage?.cacheCreationTokens, null);
});

test("usageFromNonStreamBody reads OpenAI Responses input/output tokens", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({ usage: { input_tokens: 12, output_tokens: 8 } }),
  );
  assert.deepEqual(usage, {
    promptTokens: 12,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 8,
    genMs: 0,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("usageFromNonStreamBody reads OpenAI Responses cached tokens", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      usage: {
        input_tokens: 30,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 25 },
      },
    }),
  );
  assert.equal(usage?.promptTokens, 30);
  assert.equal(usage?.cacheReadTokens, 25);
});

test("usageFromNonStreamBody sums Anthropic cache input tokens", () => {
  const usage = usageFromNonStreamBody(
    "anthropic",
    JSON.stringify({
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 240,
        cache_creation_input_tokens: 12,
        output_tokens: 9,
      },
    }),
  );
  assert.deepEqual(usage, {
    promptTokens: 253,
    cacheReadTokens: 240,
    cacheCreationTokens: 12,
    completionTokens: 9,
    genMs: 0,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("usageFromNonStreamBody meters rerank/embedding usage without completion tokens", () => {
  const usage = usageFromNonStreamBody(
    "openai",
    JSON.stringify({
      object: "list",
      usage: { prompt_tokens: 49, total_tokens: 49 },
    }),
  );
  assert.deepEqual(usage, {
    promptTokens: 49,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 0,
    genMs: 0,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("usageFromNonStreamBody returns null without usage", () => {
  assert.equal(usageFromNonStreamBody("openai", "{}"), null);
  assert.equal(usageFromNonStreamBody("openai", "not json"), null);
  assert.equal(
    usageFromNonStreamBody("openai", JSON.stringify({ usage: {} })),
    null,
  );
});

test("includeUsageRequested / withIncludeUsage", () => {
  assert.equal(
    includeUsageRequested({ stream_options: { include_usage: true } }),
    true,
  );
  assert.equal(includeUsageRequested({ stream_options: {} }), false);
  assert.equal(includeUsageRequested({}), false);
  assert.deepEqual(withIncludeUsage({ model: "m", stream_options: { x: 1 } }), {
    model: "m",
    stream_options: { x: 1, include_usage: true },
  });
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function openAiFrames(frames: string[]): Uint8Array {
  return new TextEncoder().encode(frames.map((f) => `${f}\n\n`).join(""));
}

test("createUsageMeterStream strips synthetic usage frame and meters tokens", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: true,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ id: "a", model: "m", choices: [{ delta: { content: "Hello" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));

  assert.equal(out.includes('"usage"'), false);
  assert.equal(out.includes("Hello"), true);
  assert.equal(out.includes("[DONE]"), true);
  assert.deepEqual(counted, {
    promptTokens: 3,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 4,
    genMs: 0,
    prefillMs: null,
    promptPerSecond: null,
  });
  assert.equal(Number.isInteger(counted?.genMs), true);
});

test("createUsageMeterStream counts malformed payloads and passes them through", async () => {
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: false,
    onComplete: () => undefined,
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ id: "a", model: "m", choices: [{ delta: { content: "Hi" } }] })}`,
          "data: {broken json",
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));

  assert.equal(out.includes("{broken json"), true);
  assert.deepEqual(meter.health(), {
    malformedChunks: 1,
    malformedSample: "{broken json",
    terminal: "done",
    truncationRetries: 0,
  });
});

test("createUsageMeterStream classifies the stream terminal", async () => {
  const run = async (frames: string[]) => {
    const meter = createUsageMeterStream({
      codec: openAiResumableCodec,
      stripUsageFrames: false,
      onComplete: () => undefined,
    });
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(openAiFrames(frames));
        controller.close();
      },
    });
    await drain(input.pipeThrough(meter.transform));
    return meter.health().terminal;
  };

  const content = `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`;
  const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`;

  assert.equal(await run([content, finish, "data: [DONE]"]), "done");
  assert.equal(await run([content, finish]), "finish");
  assert.equal(await run([content]), "eof");
});

test("createUsageMeterStream reports terminal via onStreamEnd at flush time", async () => {
  let seen: string | null | undefined;
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: false,
    onStreamEnd: (health) => {
      seen = health.terminal;
    },
    onComplete: () => undefined,
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`,
        ]),
      );
      controller.close();
    },
  });
  await drain(input.pipeThrough(meter.transform));
  assert.equal(seen, "eof");
});

test("createUsageMeterStream fires onReasoning before onFirstToken", async () => {
  const order: string[] = [];
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: false,
    onReasoning: () => order.push("reasoning"),
    onFirstToken: () => order.push("token"),
    onComplete: () => {},
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "more" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  await drain(input.pipeThrough(meter.transform));
  assert.deepEqual(order, ["reasoning", "token"]);
});

test("createUsageMeterStream reports upstream predicted_ms as genMs", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: true,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ id: "a", model: "m", choices: [{ delta: { content: "Hello" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 }, timings: { predicted_ms: 2000 } })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  await drain(input.pipeThrough(meter.transform));

  assert.deepEqual(counted, {
    promptTokens: 3,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 4,
    genMs: 2000,
    prefillMs: null,
    promptPerSecond: null,
  });
});

test("createUsageMeterStream passthrough keeps usage frame when not stripping", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: false,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));
  assert.equal(out.includes('"usage"'), true);
  assert.equal(counted?.completionTokens, 2);
  assert.equal(counted?.promptTokens, 1);
});

test("createUsageMeterStream meters Anthropic stream without stripping", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: anthropicResumableCodec,
    stripUsageFrames: false,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg", model: "m", usage: { input_tokens: 8 } } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } })}`,
  ];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(frames.map((f) => `${f}\n\n`).join("")),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));
  assert.equal(out.includes("message_start"), true);
  assert.equal(counted?.promptTokens, 8);
  assert.equal(counted?.completionTokens, 6);
});

test("createUsageMeterStream sums Anthropic cache input tokens", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: anthropicResumableCodec,
    stripUsageFrames: false,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg", model: "m", usage: { input_tokens: 1, cache_read_input_tokens: 199 } } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } })}`,
  ];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(frames.map((f) => `${f}\n\n`).join("")),
      );
      controller.close();
    },
  });

  await drain(input.pipeThrough(meter.transform));
  assert.equal(counted?.promptTokens, 200);
  assert.equal(counted?.completionTokens, 6);
});

test("createUsageMeterStream meters OpenAI Responses stream", async () => {
  let counted: ProxyUsageCounts | undefined;
  const meter = createUsageMeterStream({
    codec: openAiResponsesUsageCodec,
    stripUsageFrames: false,
    onComplete: (usage) => {
      counted = usage;
    },
  });

  const frames = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 30,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 25 },
        },
      },
    })}`,
  ];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(frames.map((f) => `${f}\n\n`).join("")),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));
  assert.equal(out.includes("response.completed"), true);
  assert.equal(counted?.promptTokens, 30);
  assert.equal(counted?.cacheReadTokens, 25);
  assert.equal(counted?.completionTokens, 5);
});

test("returnProgressRequested / withReturnProgress", () => {
  assert.equal(returnProgressRequested({ return_progress: true }), true);
  assert.equal(returnProgressRequested({ return_progress: false }), false);
  assert.equal(returnProgressRequested({}), false);
  assert.deepEqual(withReturnProgress({ model: "m" }), {
    model: "m",
    return_progress: true,
  });
});

test("createUsageMeterStream reports prefill progress and strips injected progress frames", async () => {
  const progress: ProxyPrefillProgress[] = [];
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: true,
    stripProgressFrames: true,
    onComplete: () => {},
    onPrefillProgress: (p) => {
      progress.push(p);
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total: 100, cache: 10, processed: 40 } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total: 100, cache: 10, processed: 100 } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 1 } })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));
  assert.deepEqual(progress, [
    { total: 100, cache: 10, processed: 40 },
    { total: 100, cache: 10, processed: 100 },
  ]);
  assert.equal(out.includes("prompt_progress"), false);
  assert.equal(out.includes("Hi"), true);
  assert.equal(out.includes("[DONE]"), true);
});

test("createUsageMeterStream keeps progress frames when not stripping", async () => {
  const progress: ProxyPrefillProgress[] = [];
  const meter = createUsageMeterStream({
    codec: openAiResumableCodec,
    stripUsageFrames: false,
    stripProgressFrames: false,
    onComplete: () => {},
    onPrefillProgress: (p) => {
      progress.push(p);
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        openAiFrames([
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: null } }], prompt_progress: { total: 50, cache: 0, processed: 25 } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
          "data: [DONE]",
        ]),
      );
      controller.close();
    },
  });

  const out = await drain(input.pipeThrough(meter.transform));
  assert.deepEqual(progress, [{ total: 50, cache: 0, processed: 25 }]);
  assert.equal(out.includes("prompt_progress"), true);
});
