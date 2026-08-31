import assert from "node:assert/strict";
import test from "node:test";

import {
  notImplementedResponse,
  openAiProtocolAdapter,
  openAiModelsList,
  openAiResumableCodec,
} from "./openai.js";

test("openAiModelsList exposes only visible proxy models", () => {
  const before = Math.floor(Date.now() / 1000);
  const response = openAiModelsList([
    {
      id: "a",
      modelId: "alpha",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      blockedMessage: "",
    },
    {
      id: "b",
      modelId: "beta",
      visible: false,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      blockedMessage: "",
    },
  ]);
  const after = Math.floor(Date.now() / 1000);

  assert.equal(response.object, "list");
  assert.equal(response.data.length, 1);
  const model = response.data[0];
  assert.ok(model);
  const { created, ...rest } = model;
  assert.ok(Number.isInteger(created));
  assert.ok(created >= before && created <= after);
  assert.deepEqual(rest, {
    id: "alpha",
    object: "model",
    owned_by: "arriero",
  });
});

test("openAiModelsList attaches per-model status in llama.cpp router style", () => {
  const response = openAiModelsList(
    [
      {
        id: "a",
        modelId: "alpha",
        visible: true,
        enabled: true,
        ownedBy: "arriero",
        targetId: null,
        routeTo: null,
        description: null,
        blockedMessage: "",
      },
    ],
    new Map([
      ["alpha", { value: "partial", activeRequests: 2, queuedRequests: 5 }],
    ]),
  );

  const model = response.data[0];
  assert.ok(model);
  const { created: _created, ...rest } = model;
  assert.deepEqual(rest, {
    id: "alpha",
    object: "model",
    owned_by: "arriero",
    status: {
      value: "partial",
      active_requests: 2,
      queued_requests: 5,
    },
  });
});

test("notImplementedResponse returns OpenAI-compatible error shape", () => {
  assert.deepEqual(notImplementedResponse("qwen", "/v1/chat/completions"), {
    error: {
      message:
        "Model qwen is published by arriero, but /v1/chat/completions forwarding is not implemented yet.",
      type: "server_error",
      param: "model",
      code: "arriero_proxy_not_implemented",
    },
  });
});

test("openAiProtocolAdapter marks a disabled model as non-retryable", () => {
  const response = openAiProtocolAdapter.diagnosticError(
    {
      operation: {
        protocol: "openai",
        endpoint: "chat.completions",
        routePath: "/v1/chat/completions",
        transport: "http-json",
      },
      body: { model: "qwen" },
      modelId: "qwen",
      model: {
        id: "a",
        modelId: "qwen",
        visible: true,
        enabled: false,
        ownedBy: "arriero",
        targetId: null,
        routeTo: null,
        description: null,
        blockedMessage: "Use qwen-next.",
      },
      stream: false,
    },
    {
      status: 409,
      code: "arriero_proxy_model_disabled",
      message: "Use qwen-next.",
      param: "model",
      errorClass: "conflict",
      retryable: false,
    },
  );

  assert.deepEqual(response, {
    status: 409,
    headers: { "x-should-retry": "false" },
    body: {
      error: {
        message: "Use qwen-next.",
        type: "invalid_request_error",
        param: "model",
        code: "arriero_proxy_model_disabled",
      },
    },
  });
});

test("openAiProtocolAdapter forwards only upstream-compatible endpoints", () => {
  assert.equal(
    openAiProtocolAdapter.upstreamPath({
      protocol: "openai",
      endpoint: "chat.completions",
      routePath: "/v1/chat/completions",
      transport: "http-json",
    }),
    "/v1/chat/completions",
  );
  assert.equal(
    openAiProtocolAdapter.upstreamPath({
      protocol: "openai",
      endpoint: "responses",
      routePath: "/v1/responses",
      transport: "http-json",
    }),
    "/v1/responses",
  );
  assert.equal(
    openAiProtocolAdapter.upstreamPath({
      protocol: "openai",
      endpoint: "rerank",
      routePath: "/v1/rerank",
      transport: "http-json",
    }),
    "/v1/rerank",
  );
  assert.equal(
    openAiProtocolAdapter.upstreamPath({
      protocol: "openai",
      endpoint: "unknown",
      routePath: "/v1/unknown",
      transport: "http-json",
    }),
    null,
  );
});

test("openAiResumableCodec.parseChunk classifies phases", () => {
  const textChunk = openAiResumableCodec.parseChunk(
    JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
  );
  assert.equal((textChunk as { phase?: string }).phase, "text");

  const tool = openAiResumableCodec.parseChunk(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "get_weather", arguments: '{"city":' },
              },
            ],
          },
        },
      ],
    }),
  );
  assert.deepEqual(tool, {
    text: "",
    finishReason: null,
    id: null,
    model: null,
    phase: "tool",
    toolCalls: [
      {
        index: 0,
        id: "call_1",
        name: "get_weather",
        arguments: '{"city":',
      },
    ],
  });

  const parallelTools = openAiResumableCodec.parseChunk(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "first", arguments: "{}" },
              },
              {
                index: 1,
                id: "call_2",
                function: { name: "second", arguments: '{"n":' },
              },
            ],
          },
        },
      ],
    }),
  );
  assert.deepEqual((parallelTools as { toolCalls?: unknown }).toolCalls, [
    { index: 0, id: "call_1", name: "first", arguments: "{}" },
    { index: 1, id: "call_2", name: "second", arguments: '{"n":' },
  ]);

  const reasoning = openAiResumableCodec.parseChunk(
    JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
  );
  assert.equal((reasoning as { phase?: string }).phase, "thinking");
  assert.equal((reasoning as { reasoning?: string }).reasoning, "hmm");
});

test("openAiResumableCodec.finalResponse preserves reasoning_content", () => {
  const json = openAiResumableCodec.finalResponse({
    text: "Answer.",
    reasoningText: "Thinking Process: step 1",
    id: "chatcmpl-1",
    model: "m",
    finishReason: "stop",
    wantsStream: false,
    completionTokens: 9,
    promptTokens: 5,
  });
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.choices[0].message.content, "Answer.");
  assert.equal(
    parsed.choices[0].message.reasoning_content,
    "Thinking Process: step 1",
  );

  const stream = openAiResumableCodec.finalResponse({
    text: "Answer.",
    reasoningText: "thinking",
    id: "chatcmpl-1",
    model: "m",
    finishReason: "stop",
    wantsStream: true,
    completionTokens: 9,
    promptTokens: 5,
  });
  assert.equal(stream.body.includes('"reasoning_content":"thinking"'), true);
});

test("openAiResumableCodec.finalResponse emits tool_calls", () => {
  const json = openAiResumableCodec.finalResponse({
    text: "",
    id: "chatcmpl-1",
    model: "m",
    finishReason: null,
    wantsStream: false,
    completionTokens: 3,
    promptTokens: 5,
    toolCalls: [
      { id: "call_1", name: "get_weather", arguments: '{"city":"Moscow"}' },
    ],
  });
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.choices[0].finish_reason, "tool_calls");
  assert.equal(parsed.choices[0].message.content, null);
  assert.deepEqual(parsed.choices[0].message.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
    },
  ]);
});
