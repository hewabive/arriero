import assert from "node:assert/strict";
import test from "node:test";

import {
  createResumableBufferState,
  runResumableUpstreamAttempt,
} from "./resumable-forward.js";
import {
  anthropicForwardHeaders,
  createAnthropicTranslationStream,
  shouldTranslateAnthropicMessages,
  translateAnthropicForwardBody,
  translateOpenAiErrorText,
  translateOpenAiResponseText,
  translatedAnthropicResumableCodec,
  type AnthropicTranslationStreamCallbacks,
} from "./translation.js";

const messagesOperation = {
  protocol: "anthropic" as const,
  endpoint: "messages",
  routePath: "/v1/messages",
  transport: "http-json" as const,
};

test("translation applies to anthropic messages on non-anthropic upstreams", () => {
  assert.equal(
    shouldTranslateAnthropicMessages(messagesOperation, "openai"),
    true,
  );
  assert.equal(
    shouldTranslateAnthropicMessages(messagesOperation, "llama-native"),
    true,
  );
  assert.equal(
    shouldTranslateAnthropicMessages(messagesOperation, "anthropic"),
    false,
  );
  assert.equal(
    shouldTranslateAnthropicMessages(
      { ...messagesOperation, endpoint: "messages.count_tokens" },
      "openai",
    ),
    false,
  );
  assert.equal(
    shouldTranslateAnthropicMessages(
      { ...messagesOperation, protocol: "openai" },
      "openai",
    ),
    false,
  );
});

test("forward body uses llama-server dialect with filtered named tool_choice", () => {
  const body = translateAnthropicForwardBody({
    model: "m",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "a", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "tool", name: "b" },
  }).body as Record<string, unknown>;
  assert.equal(body.tool_choice, "required");
  assert.equal((body.tools as unknown[]).length, 1);
});

test("forward body no longer strips attribution (moved to strip-attribution node)", () => {
  const body = translateAnthropicForwardBody({
    model: "m",
    max_tokens: 16,
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.37; cc_entrypoint=cli; cch=14f72;",
      },
      { type: "text", text: "You are X." },
    ],
    messages: [{ role: "user", content: "hi" }],
  }).body as Record<string, unknown>;
  const messages = body.messages as Record<string, unknown>[];
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content as string, /x-anthropic-billing-header/);
});

test("forward body maps adaptive thinking and output_config effort to llama fields", () => {
  const { body, warnings } = translateAnthropicForwardBody({
    model: "m",
    max_tokens: 16,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: "hi" }],
  });
  const record = body as Record<string, unknown>;
  assert.equal(record.reasoning_effort, "medium");
  assert.deepEqual(record.chat_template_kwargs, { enable_thinking: true });
  assert.equal(record.thinking_budget_tokens, undefined);
  assert.deepEqual(warnings, []);
});

test("anthropic headers are stripped from forwarded requests", () => {
  const headers = anthropicForwardHeaders(
    new Headers({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "x",
      "x-api-key": "secret",
      "content-type": "application/json",
    }),
  );
  assert.equal(headers.get("anthropic-version"), null);
  assert.equal(headers.get("anthropic-beta"), null);
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("content-type"), "application/json");
});

test("non-stream response and error bodies translate to anthropic shapes", () => {
  const translated = translateOpenAiResponseText(
    JSON.stringify({
      id: "chatcmpl-9",
      model: "m",
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }),
  );
  assert.ok(translated);
  const parsed = JSON.parse(translated) as Record<string, unknown>;
  assert.equal(parsed.type, "message");
  assert.equal(parsed.stop_reason, "end_turn");
  assert.equal(translateOpenAiResponseText("not json"), null);

  const error = JSON.parse(
    translateOpenAiErrorText(
      404,
      JSON.stringify({ error: { message: "nope" } }),
    ),
  ) as { type: string; error: { type: string; message: string } };
  assert.deepEqual(error, {
    type: "error",
    error: { type: "not_found_error", message: "nope" },
  });
});

test("llama.cpp context overflow normalizes to Anthropic prompt-too-long error", () => {
  const error = JSON.parse(
    translateOpenAiErrorText(
      400,
      JSON.stringify({
        error: {
          type: "exceed_context_size_error",
          message:
            "request (32768 tokens) exceeds the available context size (32000 tokens)",
          n_prompt_tokens: 32768,
          n_ctx: 32000,
        },
      }),
    ),
  );
  assert.deepEqual(error, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Prompt is too long",
    },
  });
});

test("context overflow normalization is limited to llama.cpp HTTP 400 errors", () => {
  const error = JSON.parse(
    translateOpenAiErrorText(
      500,
      JSON.stringify({
        error: {
          type: "exceed_context_size_error",
          message: "upstream failed",
        },
      }),
    ),
  );
  assert.deepEqual(error, {
    type: "error",
    error: { type: "api_error", message: "upstream failed" },
  });
});

async function runTransform(
  frames: string[],
  callbacks: AnthropicTranslationStreamCallbacks = {},
): Promise<string> {
  const { transform } = createAnthropicTranslationStream(callbacks);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const reading = (async () => {
    const reader = transform.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })();
  const writer = transform.writable.getWriter();
  for (const frame of frames) {
    await writer.write(encoder.encode(frame));
  }
  await writer.close();
  await reading;
  return chunks.join("");
}

test("translation transform re-emits anthropic SSE from openai stream", async () => {
  const output = await runTransform([
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ]);

  const eventNames = [...output.matchAll(/^event: (.+)$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(eventNames, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.ok(output.includes('"text":"Hi"'));
  assert.ok(output.includes('"output_tokens":1'));
  assert.ok(output.includes('"input_tokens":5'));
});

test("translation stream reports telemetry through emitter extensions", async () => {
  const prefill: Array<{ total: number; processed: number; cache: number }> =
    [];
  const firstTokens: Array<number | null> = [];
  const completions: Array<{
    promptTokens: number | null;
    cacheReadTokens: number | null;
    completionTokens: number;
    genMs: number;
  }> = [];

  await runTransform(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        model: "m",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
        prompt_progress: { total: 40, cache: 8, processed: 24 },
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
        timings: { predicted_ms: 250.4 },
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ],
    {
      onPrefillProgress: (progress) => prefill.push(progress),
      onFirstToken: (promptTokens) => firstTokens.push(promptTokens),
      onComplete: (usage) =>
        completions.push({
          promptTokens: usage.promptTokens,
          cacheReadTokens: usage.cacheReadTokens,
          completionTokens: usage.completionTokens,
          genMs: usage.genMs,
        }),
    },
  );

  assert.deepEqual(prefill, [{ total: 40, processed: 24, cache: 8 }]);
  assert.deepEqual(firstTokens, [null]);
  assert.deepEqual(completions, [
    {
      promptTokens: 40,
      cacheReadTokens: 8,
      completionTokens: 2,
      genMs: 250,
    },
  ]);
});

test("translation stream fires onReasoning before onFirstToken", async () => {
  const order: string[] = [];
  await runTransform(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        model: "m",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "thinking" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ],
    {
      onReasoning: () => order.push("reasoning"),
      onFirstToken: () => order.push("token"),
    },
  );

  assert.deepEqual(order, ["reasoning", "token"]);
});

function openAiFrame(input: { content?: string; finish?: string }) {
  return `data: ${JSON.stringify({
    id: "cmpl",
    model: "m",
    choices: [
      {
        index: 0,
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("translated resumable codec builds openai upstream body with prefill tail", () => {
  const codec = translatedAnthropicResumableCodec(
    translateAnthropicForwardBody({
      model: "claude-x",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }).body,
  );
  const resumed = codec.upstreamBody(null, "AB") as Record<string, unknown>;
  const messages = resumed.messages as Array<Record<string, unknown>>;
  assert.equal(resumed.stream, true);
  assert.equal(resumed.max_tokens, 32);
  assert.deepEqual(messages.at(-1), { role: "assistant", content: "AB" });
  assert.equal(messages[0]?.content, "hi");
});

test("translated resumable codec maps openai finish reasons in final response", () => {
  const codec = translatedAnthropicResumableCodec(
    translateAnthropicForwardBody({
      model: "claude-x",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }).body,
  );
  const final = codec.finalResponse({
    text: "Hello",
    id: "cmpl-1",
    model: "m",
    finishReason: "stop",
    wantsStream: false,
    completionTokens: 5,
    promptTokens: 10,
  });
  const body = JSON.parse(final.body) as Record<string, unknown>;
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "end_turn");
  assert.deepEqual(body.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 5 });
});

test("translated resumable codec replays distinct tool_use blocks per tool call", () => {
  const codec = translatedAnthropicResumableCodec(
    translateAnthropicForwardBody({
      model: "claude-x",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }).body,
  );
  const final = codec.finalResponse({
    text: "",
    id: "cmpl-1",
    model: "m",
    finishReason: "tool_calls",
    wantsStream: true,
    completionTokens: 7,
    promptTokens: 11,
    toolCalls: [
      { id: "call_a", name: "get_weather", arguments: '{"city":"Moscow"}' },
      { id: "call_b", name: "get_time", arguments: "{}" },
    ],
  });
  const starts = [
    ...final.body.matchAll(/"type":"content_block_start".+?"name":"(\w+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(starts, ["get_weather", "get_time"]);
  assert.match(final.body, /"partial_json":"{\\"city\\":\\"Moscow\\"}"/);
  assert.match(final.body, /"stop_reason":"tool_use"/);
});

test("translated resumable codec survives preemption and resumes openai frames", async () => {
  const codec = translatedAnthropicResumableCodec(
    translateAnthropicForwardBody({
      model: "claude-x",
      max_tokens: 32,
      messages: [{ role: "user", content: "count" }],
      stream: true,
    }).body,
  );
  const state = createResumableBufferState();
  const preempt = new AbortController();

  const first = runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: codec.upstreamBody(null, null),
    codec,
    state,
    preemptSignal: preempt.signal,
    fetchImpl: makeFetch([openAiFrame({ content: "AB" })], { hang: true }),
  });
  await flush();
  preempt.abort();
  assert.equal((await first).type, "preempted");
  assert.equal(state.text, "AB");

  const second = await runResumableUpstreamAttempt({
    url: "http://upstream",
    method: "POST",
    headers: {},
    body: codec.upstreamBody(null, state.text),
    codec,
    state,
    preemptSignal: new AbortController().signal,
    fetchImpl: makeFetch([
      openAiFrame({ content: "CD" }),
      openAiFrame({ finish: "stop" }),
      "data: [DONE]\n\n",
    ]),
  });
  assert.equal(second.type, "completed");
  assert.equal(state.text, "ABCD");

  const final = codec.finalResponse({
    text: state.text,
    id: state.id,
    model: state.model,
    finishReason: state.finishReason,
    wantsStream: true,
    completionTokens: state.completionTokens,
    promptTokens: state.promptTokens,
  });
  assert.equal(final.headers["content-type"], "text/event-stream");
  assert.match(final.body, /event: message_start/);
  assert.match(final.body, /"text":"ABCD"/);
  assert.match(final.body, /"stop_reason":"end_turn"/);
  assert.match(final.body, /event: message_stop/);
});

test("translation transform finalizes aborted streams on flush", async () => {
  const output = await runTransform([
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      model: "m",
      choices: [
        { index: 0, delta: { content: "partial" }, finish_reason: null },
      ],
    })}\n\n`,
  ]);
  const eventNames = [...output.matchAll(/^event: (.+)$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(eventNames, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});
