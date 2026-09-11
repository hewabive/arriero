import assert from "node:assert/strict";
import { test } from "node:test";

import { captureApiProxyResponseSse } from "./response-capture.js";
import {
  apiProxySseDataFrame,
  apiProxySseEventFrame,
} from "./response-codec.js";
import { createProxyTrace } from "./protocol-trace.js";
import { readApiProxyRequestFile } from "./request-files.js";
import {
  clearApiProxyBroadcasts,
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";
import {
  findApiProxyInFlight,
  registerApiProxyInFlight,
} from "./response-coalesce.js";
import { createApiProxyResponsePlanExecutor } from "./response-plan.js";

function trace() {
  const value = createProxyTrace({
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    transport: "http-json",
  });
  value.modelId = "public-model";
  return value;
}

const operation = {
  protocol: "openai" as const,
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json" as const,
};

const jsonResponse = {
  status: 200,
  contentType: "application/json",
  isSse: false,
};

const sseResponse = {
  status: 200,
  contentType: "text/event-stream",
  isSse: true,
};

const chatChunks = [
  {
    id: "chat-1",
    object: "chat.completion.chunk",
    model: "model",
    choices: [
      { index: 1, delta: { content: "Second" } },
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "При",
          reasoning_content: "Think ",
        },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: {
          content: "вет 🌍",
          reasoning_content: "carefully",
          tool_calls: [
            {
              index: 1,
              id: "call-b",
              type: "function",
              function: { name: "second", arguments: "{}" },
            },
            {
              index: 0,
              id: "call-a",
              type: "function",
              function: { name: "lookup", arguments: '{"city":"' },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: {
          content: null,
          tool_calls: [{ index: 0, function: { arguments: 'Москва"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
  {
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  },
];

const assembledChat = {
  id: "chat-1",
  object: "chat.completion",
  model: "model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Привет 🌍",
        reasoning_content: "Think carefully",
        tool_calls: [
          {
            id: "call-a",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"Москва"}' },
          },
          {
            id: "call-b",
            type: "function",
            function: { name: "second", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
    { index: 1, message: { role: "assistant", content: "Second" } },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

for (const streamed of [false, true]) {
  test(`SSE capture assembles choices, reasoning and tools at each pipeline position, streamed=${streamed}`, async () => {
    const value = trace();
    const writes: string[] = [];
    const plan = createApiProxyResponsePlanExecutor({
      effects: [
        { type: "capture-response", nodeName: "Client" },
        {
          type: "replace-response-text",
          rules: [{ enabled: true, find: "Привет", replace: "Hello" }],
          includeReasoning: false,
          includeToolArguments: false,
        },
        { type: "token-scale", factor: 2 },
        { type: "capture-response", nodeName: "Target" },
        { type: "cache-store", key: "readable-capture", ttlSeconds: 600 },
      ],
      putCache: ({ body }) => writes.push(body),
      trace: value,
      operation,
    });
    assert.ok(plan);
    const body =
      chatChunks.map(apiProxySseDataFrame).join("") + "data: [DONE]\n\n";
    let delivered: string;
    if (streamed) {
      const bytes = new TextEncoder().encode(body);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset < bytes.length) {
            controller.enqueue(bytes.slice(offset, offset + 1));
            offset += 1;
          } else {
            controller.close();
          }
        },
      });
      delivered = await new Response(plan.tap(stream, sseResponse)).text();
    } else {
      delivered = plan.processText(body, sseResponse);
    }
    plan.flush();
    assert.match(delivered, /data: \[DONE\]/);
    assert.deepEqual(writes, [body]);
    const files = new Map(
      value.files.map((file) => [
        file.label,
        readApiProxyRequestFile(file.path)?.data,
      ]),
    );
    assert.deepEqual(files.get("Target"), assembledChat);
    const expected = structuredClone(assembledChat);
    expected.choices[0]!.message.content = "Hello 🌍";
    expected.usage = {
      prompt_tokens: 24,
      completion_tokens: 14,
      total_tokens: 38,
    };
    assert.deepEqual(files.get("Client"), expected);
  });
}

test("SSE capture assembles legacy completions and logprobs", () => {
  const body = [
    {
      object: "text_completion",
      choices: [
        {
          index: 0,
          text: "one ",
          logprobs: { tokens: ["one"], token_logprobs: [-1], text_offset: [0] },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          text: "two",
          logprobs: { tokens: ["two"], token_logprobs: [-2], text_offset: [4] },
          finish_reason: "stop",
        },
      ],
    },
  ]
    .map(apiProxySseDataFrame)
    .join("");
  assert.deepEqual(
    captureApiProxyResponseSse(body, { ...operation, endpoint: "completions" }),
    {
      object: "text_completion",
      choices: [
        {
          index: 0,
          text: "one two",
          logprobs: {
            tokens: ["one", "two"],
            token_logprobs: [-1, -2],
            text_offset: [0, 4],
          },
          finish_reason: "stop",
        },
      ],
    },
  );
});

test("Anthropic capture assembles text, thinking, signatures, tool input and usage", () => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 5,
        },
      },
    },
    { type: "ping" },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "Think ", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "carefully" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "При" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "вет" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "citations_delta",
        citation: { type: "char_location", cited_text: "Привет" },
      },
    },
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "search",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"hello"}' },
    },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => apiProxySseEventFrame(event.type, event))
    .join("");
  const anthropicOperation = {
    ...operation,
    protocol: "anthropic" as const,
    endpoint: "messages",
  };
  assert.deepEqual(captureApiProxyResponseSse(body, anthropicOperation), {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [
      { type: "thinking", thinking: "Think carefully", signature: "signed" },
      {
        type: "text",
        text: "Привет",
        citations: [{ type: "char_location", cited_text: "Привет" }],
      },
      { type: "tool_use", id: "tool-1", name: "search", input: { q: "hello" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 5 },
  });
  assert.deepEqual(
    captureApiProxyResponseSse(
      body + "event: unknown\ndata: broken\n\n",
      anthropicOperation,
    ),
    {
      events: [
        ...events.map((data) => ({ event: data.type, data })),
        { event: "unknown", data: "broken" },
      ],
    },
  );
});

for (const status of ["completed", "failed", "incomplete"]) {
  test(`Responses capture uses the ${status} aggregate without duplicating deltas`, () => {
    const response = {
      id: "resp-1",
      status,
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      ],
      usage: { output_tokens: 1 },
    };
    const body =
      apiProxySseEventFrame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "Hello",
      }) +
      apiProxySseEventFrame(`response.${status}`, {
        type: `response.${status}`,
        response,
      });
    assert.deepEqual(
      captureApiProxyResponseSse(body, { ...operation, endpoint: "responses" }),
      response,
    );
  });
}

test("SSE captures support multiline JSON, CRLF and a final unterminated frame", () => {
  assert.deepEqual(
    captureApiProxyResponseSse(
      ': ping\r\n\r\ndata: {"choices": [\r\ndata: {"delta":{"content":"Hello"}}]}',
      operation,
    ),
    {
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" } }],
    },
  );
});

test("response plan returns null when it has no effects", () => {
  const sink = createApiProxyResponsePlanExecutor({
    effects: [],
    putCache: () => {},
    trace: trace(),
    operation,
  });
  assert.equal(sink, null);
});

test("response plan unwinds captures in reverse order and is idempotent", () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Audit" },
      { type: "capture-response", nodeName: null },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.processText(
    JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
    jsonResponse,
  );
  sink.flush();
  sink.flush();

  assert.equal(value.files.length, 2);
  const [first, second] = value.files;
  assert.ok(first && second);
  assert.equal(first.kind, "capture-response");
  assert.equal(first.label, null);
  assert.equal(second.label, "Audit");

  const record = readApiProxyRequestFile(second.path);
  assert.ok(record);
  assert.deepEqual(record.data, {
    choices: [{ message: { content: "hi" } }],
  });
});

test("captures on either side of a response transform see positional bodies", () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Before replace" },
      {
        type: "replace-response-text",
        rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
        includeReasoning: false,
        includeToolArguments: false,
      },
      { type: "capture-response", nodeName: "After replace" },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);

  const delivered = plan.processText(
    JSON.stringify({
      choices: [{ message: { content: "the secret" } }],
    }),
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    choices: [{ message: { content: "the [hidden]" } }],
  });
  assert.deepEqual(
    value.files.map((file) => file.label),
    ["After replace", "Before replace"],
  );
  const raw = readApiProxyRequestFile(value.files[0]!.path);
  const transformed = readApiProxyRequestFile(value.files[1]!.path);
  assert.deepEqual(raw?.data, {
    choices: [{ message: { content: "the secret" } }],
  });
  assert.deepEqual(transformed?.data, {
    choices: [{ message: { content: "the [hidden]" } }],
  });
});

test("token scaling leaves the inner capture real and the outer capture client-visible", () => {
  const value = trace();
  value.usage = {
    promptTokens: 10_000,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 2_000,
    genMs: 1_000,
    ratePerSecond: 2_000,
    prefillMs: null,
    promptPerSecond: null,
  };
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Client-visible" },
      { type: "token-scale", factor: 10 },
      { type: "capture-response", nodeName: "Real target" },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);
  const delivered = plan.processText(
    JSON.stringify({
      usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
    }),
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    usage: { prompt_tokens: 100_000, completion_tokens: 20_000 },
  });
  const real = readApiProxyRequestFile(value.files[0]!.path);
  const visible = readApiProxyRequestFile(value.files[1]!.path);
  assert.deepEqual(real?.data, {
    usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
  });
  assert.deepEqual(visible?.data, {
    usage: { prompt_tokens: 100_000, completion_tokens: 20_000 },
  });
  assert.equal(value.usage.promptTokens, 10_000);
  assert.equal(value.usage.completionTokens, 2_000);
  assert.equal(value.usage.ratePerSecond, 2_000);
});

test("response plan composes fusion branch effects after route effects", () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Outer" },
      { type: "token-scale", factor: 10 },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);
  const delivered = plan.processText(
    '{"usage":{"prompt_tokens":100,"completion_tokens":20}}',
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    usage: { prompt_tokens: 1_000, completion_tokens: 200 },
  });
  assert.deepEqual(readApiProxyRequestFile(value.files[0]!.path)?.data, {
    usage: { prompt_tokens: 1_000, completion_tokens: 200 },
  });
});

test("response plan writes nothing when no body was seen", () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "capture-response", nodeName: null }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.flush();
  assert.equal(value.files.length, 0);
});

test("response plan writes non-stream bodies to the cache and marks the trace", () => {
  const value = trace();
  const writes: Array<{ key: string; body: string; ttlSeconds: number }> = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "key-1", ttlSeconds: 600 }],
    putCache: (input) =>
      writes.push({
        key: input.key,
        body: input.body,
        ttlSeconds: input.ttlSeconds,
      }),
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.processText('{"object":"list","data":[]}', jsonResponse);
  sink.flush();

  assert.deepEqual(writes, [
    { key: "key-1", body: '{"object":"list","data":[]}', ttlSeconds: 600 },
  ]);
  assert.equal(value.cache, "store");
});

test("cache stores the response visible at its position around a transform", () => {
  const writes = new Map<string, string>();
  const replacement = {
    type: "replace-response-text" as const,
    rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
    includeReasoning: false,
    includeToolArguments: false,
  };
  const raw = JSON.stringify({
    choices: [{ message: { content: "secret" } }],
  });
  for (const effects of [
    [
      { type: "cache-store" as const, key: "outer", ttlSeconds: 600 },
      replacement,
    ],
    [
      replacement,
      { type: "cache-store" as const, key: "inner", ttlSeconds: 600 },
    ],
  ]) {
    const plan = createApiProxyResponsePlanExecutor({
      effects,
      putCache: (input) => writes.set(input.key, input.body),
      trace: trace(),
      operation,
    });
    assert.ok(plan);
    plan.processText(raw, jsonResponse);
    plan.flush();
  }

  assert.equal(
    (
      JSON.parse(writes.get("outer") ?? "null") as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "[hidden]",
  );
  assert.equal(
    (
      JSON.parse(writes.get("inner") ?? "null") as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "secret",
  );
});

test("response plan does not cache an error body", async () => {
  const value = trace();
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "key-err", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"error":{"message":"nope"}}', jsonResponse);
  sink.flush();
  assert.equal(writes.length, 0);
  assert.equal(value.cache, null);
});

test("response plan captures failed responses without caching or transforming them", () => {
  const value = trace();
  value.errorMessage = "nope";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Diagnostics" },
      { type: "cache-store", key: "key-failed", ttlSeconds: 600 },
      { type: "token-scale", factor: 10 },
    ],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);

  const body = '{"error":{"message":"nope"},"usage":{"completion_tokens":2}}';
  const delivered = sink.processText(body, {
    ...jsonResponse,
    status: 502,
  });
  sink.flush();

  assert.equal(delivered, body);
  assert.equal(value.files.length, 1);
  assert.deepEqual(
    readApiProxyRequestFile(value.files[0]!.path)?.data,
    JSON.parse(body),
  );
  assert.deepEqual(writes, []);
});

test("response plan captures non-JSON error bodies verbatim", () => {
  const value = trace();
  value.errorMessage = "Bad Gateway";
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "capture-response", nodeName: null }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  const body = "<html><body>Bad Gateway</body></html>";
  assert.equal(
    sink.processText(body, {
      status: 502,
      contentType: "text/html",
      isSse: false,
    }),
    body,
  );
  sink.flush();
  assert.equal(value.files.length, 1);
  assert.equal(readApiProxyRequestFile(value.files[0]!.path)?.data, body);
});

test("response plan captures a completed SSE error body without caching it", async () => {
  const value = trace();
  value.errorMessage = "generation failed";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: null },
      { type: "cache-store", key: "sse-error", ttlSeconds: 600 },
    ],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  const body =
    'data: {"error":{"message":"generation failed"}}\n\ndata: [DONE]\n\n';
  const source = new Response(body).body;
  assert.ok(source);
  assert.equal(await new Response(sink.tap(source, sseResponse)).text(), body);
  sink.flush();
  assert.equal(value.files.length, 1);
  assert.deepEqual(readApiProxyRequestFile(value.files[0]!.path)?.data, {
    error: { message: "generation failed" },
  });
  assert.deepEqual(writes, []);
});

for (const scenario of [
  {
    name: "OpenAI done",
    operation,
    body: 'data: {"choices":[{"delta":{"content":"Привет"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    complete: true,
  },
  {
    name: "unfinished done frame",
    operation,
    body: "data: [DONE]\n",
    complete: false,
  },
  {
    name: "done text inside content",
    operation,
    body: 'data: {"choices":[{"delta":{"content":"[DONE]"}}]}\n\n',
    complete: false,
  },
  {
    name: "finish reason before the usage tail",
    operation,
    body: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    complete: false,
  },
  {
    name: "Anthropic message stop",
    operation: {
      ...operation,
      protocol: "anthropic" as const,
      endpoint: "messages",
    },
    body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    complete: true,
  },
  ...["completed", "failed", "incomplete"].map((ending) => ({
    name: `Responses ${ending}`,
    operation: { ...operation, endpoint: "responses" },
    body: `event: response.${ending}\ndata: {"type":"response.${ending}"}\n\n`,
    complete: true,
  })),
]) {
  test(`capture after client cancellation handles ${scenario.name}`, async () => {
    const value = trace();
    const writes: string[] = [];
    const plan = createApiProxyResponsePlanExecutor({
      effects: [
        { type: "capture-response", nodeName: null },
        { type: "cache-store", key: "cancelled-sse", ttlSeconds: 600 },
      ],
      putCache: (input) => writes.push(input.key),
      trace: value,
      operation: scenario.operation,
    });
    assert.ok(plan);
    const bytes = new TextEncoder().encode(scenario.body);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + 7));
          offset += 7;
        }
      },
    });
    const reader = plan.tap(source, sseResponse).getReader();
    for (let received = 0; received < bytes.length; ) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += chunk.value!.length;
    }
    await reader.cancel();
    plan.flush();
    plan.flush();

    assert.equal(value.files.length, scenario.complete ? 1 : 0);
    if (scenario.complete) {
      assert.deepEqual(
        readApiProxyRequestFile(value.files[0]!.path)?.data,
        captureApiProxyResponseSse(scenario.body, scenario.operation),
      );
    }
    assert.deepEqual(writes, []);
  });
}

test("a streaming owner stores SSE, feeds the broadcast, and finishes it", async () => {
  clearApiProxyBroadcasts();
  const value = trace();
  const writes: Array<{ isSse: boolean; contentType: string; body: string }> =
    [];
  registerApiProxyBroadcast("bkey");
  const subscriber = subscribeApiProxyBroadcast("bkey");
  assert.ok(subscriber);

  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "bkey", ttlSeconds: 600 }],
    putCache: (input) =>
      writes.push({
        isSse: input.isSse,
        contentType: input.contentType,
        body: input.body,
      }),
    trace: value,
    operation,
  });
  assert.ok(sink);

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("data: a\n\n"));
      controller.enqueue(encoder.encode("data: b\n\n"));
      controller.close();
    },
  });
  const reader = sink.tap(source, sseResponse).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) {
      break;
    }
  }
  sink.flush();

  assert.deepEqual(writes, [
    {
      isSse: true,
      contentType: "text/event-stream",
      body: "data: a\n\ndata: b\n\n",
    },
  ]);
  assert.equal(value.cache, "store");

  const decoder = new TextDecoder();
  let received = "";
  const subReader = subscriber.body.getReader();
  for (;;) {
    const { done, value: chunk } = await subReader.read();
    if (done) {
      break;
    }
    received += decoder.decode(chunk, { stream: true });
  }
  assert.equal(received, "data: a\n\ndata: b\n\n");
  assert.equal(subscribeApiProxyBroadcast("bkey"), null);
});

test("response plan preserves malformed SSE payloads as readable events", async () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "capture-response", nodeName: null }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("data: a\n\n"));
      controller.enqueue(encoder.encode("data: b\n\n"));
      controller.close();
    },
  });

  const tapped = sink.tap(source, sseResponse);
  const reader = tapped.getReader();
  const decoder = new TextDecoder();
  let forwarded = "";
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) {
      break;
    }
    forwarded += decoder.decode(chunk, { stream: true });
  }
  sink.flush();

  assert.equal(forwarded, "data: a\n\ndata: b\n\n");
  assert.equal(value.files.length, 1);
  const record = readApiProxyRequestFile(value.files[0]!.path);
  assert.ok(record);
  assert.deepEqual(record.data, {
    events: [
      { event: null, data: "a" },
      { event: null, data: "b" },
    ],
  });
});

test("flushing a plan that saw no response settles in-flight and aborts the broadcast", async () => {
  clearApiProxyBroadcasts();
  registerApiProxyBroadcast("leak-key");
  registerApiProxyInFlight("leak-key");
  const subscriber = subscribeApiProxyBroadcast("leak-key");
  assert.ok(subscriber);
  const reader = subscriber.body.getReader();

  const value = trace();
  value.errorMessage = "fusion quorum not met";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "leak-key", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.flush();

  await assert.rejects(reader.read(), /fusion quorum not met/);
  assert.equal(findApiProxyInFlight("leak-key"), null);
  assert.equal(subscribeApiProxyBroadcast("leak-key"), null);
  assert.deepEqual(writes, []);
});

test("an upstream error final is not pushed to coalesced followers", async () => {
  clearApiProxyBroadcasts();
  registerApiProxyBroadcast("err-key");
  const subscriber = subscribeApiProxyBroadcast("err-key");
  assert.ok(subscriber);
  const reader = subscriber.body.getReader();

  const value = trace();
  value.errorMessage = "Proxy target llama failed to forward request: boom";
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "err-key", ttlSeconds: 600 }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"error":{"message":"boom"}}', {
    status: 502,
    contentType: "application/json",
    isSse: true,
  });
  sink.flush();

  await assert.rejects(reader.read(), /failed to forward request/);
});

test("a cache-served response keeps its hit marker when an upstream store flushes", () => {
  const value = trace();
  value.cache = "hit";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "upstream-key", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"object":"chat.completion"}', jsonResponse);
  sink.flush();

  assert.deepEqual(writes, ["upstream-key"]);
  assert.equal(value.cache, "hit");
});
