import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicError,
  anthropicProtocolAdapter,
  anthropicResumableCodec,
} from "./anthropic.js";

const operation = {
  protocol: "anthropic" as const,
  endpoint: "messages",
  routePath: "/v1/messages",
  transport: "http-json" as const,
};

test("anthropicError returns Anthropic-compatible error shape", () => {
  assert.deepEqual(
    anthropicError({
      message: "bad request",
      type: "invalid_request_error",
    }),
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "bad request",
      },
    },
  );
});

test("anthropicProtocolAdapter returns not implemented response", () => {
  const response = anthropicProtocolAdapter.notImplemented({
    operation,
    body: { model: "claude-local" },
    modelId: "claude-local",
    model: {
      id: "model-a",
      modelId: "claude-local",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      blockedMessage: "",
    },
    stream: false,
  });

  assert.equal(response.status, 501);
  assert.deepEqual(response.body, {
    type: "error",
    error: {
      type: "api_error",
      message:
        "Model claude-local is published by arriero, but /v1/messages forwarding is not implemented yet.",
    },
  });
});

test("anthropicProtocolAdapter exposes context overflow as an invalid request", () => {
  const response = anthropicProtocolAdapter.diagnosticError(
    {
      operation,
      body: { model: "claude-local" },
      modelId: "claude-local",
      model: {
        id: "model-a",
        modelId: "claude-local",
        visible: true,
        enabled: true,
        ownedBy: "arriero",
        targetId: null,
        routeTo: null,
        description: null,
        blockedMessage: "",
      },
      stream: false,
    },
    {
      status: 400,
      code: "arriero_proxy_context_overflow",
      message: "Prompt is too long",
      param: null,
      errorClass: "invalid-request",
    },
  );

  assert.deepEqual(response, {
    status: 400,
    body: {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Prompt is too long",
      },
    },
  });
});

test("anthropicProtocolAdapter exposes a disabled model as a non-retryable conflict", () => {
  const response = anthropicProtocolAdapter.diagnosticError(
    {
      operation,
      body: { model: "claude-local" },
      modelId: "claude-local",
      model: {
        id: "model-a",
        modelId: "claude-local",
        visible: true,
        enabled: false,
        ownedBy: "arriero",
        targetId: null,
        routeTo: null,
        description: null,
        blockedMessage: "Use claude-replacement.",
      },
      stream: false,
    },
    {
      status: 409,
      code: "arriero_proxy_model_disabled",
      message: "Use claude-replacement.",
      param: "model",
      errorClass: "conflict",
      retryable: false,
    },
  );

  assert.deepEqual(response, {
    status: 409,
    headers: { "x-should-retry": "false" },
    body: {
      type: "error",
      error: {
        type: "conflict_error",
        message: "Use claude-replacement. (arriero_proxy_model_disabled)",
      },
    },
  });
});

test("anthropicProtocolAdapter keeps a disabled source out of the login flow", () => {
  assert.deepEqual(
    anthropicProtocolAdapter.authError({
      status: 423,
      code: "arriero_proxy_source_disabled",
      errorClass: "permission",
      message: "Contact the administrator.",
    }),
    {
      status: 423,
      body: {
        type: "error",
        error: {
          type: "permission_error",
          message: "Contact the administrator.",
        },
      },
    },
  );
});

test("anthropicResumableCodec.upstreamBody forces stream and appends prefill", () => {
  const first = anthropicResumableCodec.upstreamBody(
    { model: "m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    null,
  ) as Record<string, unknown>;
  assert.equal(first.stream, true);
  assert.equal(first.max_tokens, 64);
  assert.equal((first.messages as unknown[]).length, 1);

  const resumed = anthropicResumableCodec.upstreamBody(
    { messages: [{ role: "user", content: "hi" }] },
    "so far",
  ) as Record<string, unknown>;
  const messages = resumed.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[messages.length - 1], {
    role: "assistant",
    content: "so far",
  });
});

test("anthropicResumableCodec.parseChunk reads Anthropic SSE events", () => {
  assert.equal(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({ type: "message_stop" }),
    ),
    "done",
  );
  assert.equal(anthropicResumableCodec.parseChunk("not json"), "malformed");
  assert.equal(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({ type: "content_block_start", index: 0 }),
    ),
    null,
  );

  assert.deepEqual(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      }),
    ),
    { text: "Hi", finishReason: null, id: null, model: null, phase: "text" },
  );

  assert.deepEqual(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
      }),
    ),
    {
      text: "",
      finishReason: null,
      id: null,
      model: null,
      phase: "tool",
      toolCall: { index: 1, id: "toolu_1", name: "get_weather" },
    },
  );

  assert.deepEqual(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      }),
    ),
    {
      text: "",
      finishReason: null,
      id: null,
      model: null,
      phase: "tool",
      toolCall: { index: 1, arguments: '{"city":' },
    },
  );

  assert.deepEqual(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({
        type: "message_start",
        message: { id: "msg_1", model: "m", usage: { input_tokens: 5 } },
      }),
    ),
    {
      text: "",
      finishReason: null,
      id: "msg_1",
      model: "m",
      usage: {
        promptTokens: 5,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        completionTokens: null,
      },
    },
  );

  assert.deepEqual(
    anthropicResumableCodec.parseChunk(
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      }),
    ),
    {
      text: "",
      finishReason: "end_turn",
      id: null,
      model: null,
      usage: {
        promptTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        completionTokens: 7,
      },
    },
  );
});

test("anthropicResumableCodec.finalResponse synthesizes a message", () => {
  const json = anthropicResumableCodec.finalResponse({
    text: "hello",
    id: "msg_1",
    model: "m",
    finishReason: "end_turn",
    wantsStream: false,
    completionTokens: 7,
    promptTokens: 5,
  });
  assert.equal(json.headers["content-type"], "application/json");
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.type, "message");
  assert.deepEqual(parsed.content, [{ type: "text", text: "hello" }]);
  assert.equal(parsed.stop_reason, "end_turn");
  assert.deepEqual(parsed.usage, { input_tokens: 5, output_tokens: 7 });

  const sse = anthropicResumableCodec.finalResponse({
    text: "hello",
    id: "msg_1",
    model: "m",
    finishReason: "end_turn",
    wantsStream: true,
    completionTokens: 7,
    promptTokens: 5,
  });
  assert.equal(sse.headers["content-type"], "text/event-stream");
  assert.match(sse.body, /event: message_start/);
  assert.match(sse.body, /"type":"text_delta","text":"hello"/);
  assert.match(sse.body, /event: message_stop/);
});

test("anthropicResumableCodec preserves thinking content", () => {
  const chunk = anthropicResumableCodec.parseChunk(
    JSON.stringify({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "let me think" },
    }),
  );
  assert.equal((chunk as { phase?: string }).phase, "thinking");
  assert.equal((chunk as { reasoning?: string }).reasoning, "let me think");

  const json = anthropicResumableCodec.finalResponse({
    text: "answer",
    reasoningText: "let me think",
    id: "msg_1",
    model: "m",
    finishReason: "end_turn",
    wantsStream: false,
    completionTokens: 7,
    promptTokens: 5,
  });
  const parsed = JSON.parse(json.body);
  assert.deepEqual(parsed.content[0], {
    type: "thinking",
    thinking: "let me think",
    signature: "",
  });
  assert.deepEqual(parsed.content[1], { type: "text", text: "answer" });

  const sse = anthropicResumableCodec.finalResponse({
    text: "answer",
    reasoningText: "let me think",
    id: "msg_1",
    model: "m",
    finishReason: "end_turn",
    wantsStream: true,
    completionTokens: 7,
    promptTokens: 5,
  });
  assert.match(sse.body, /"type":"thinking_delta","thinking":"let me think"/);
});

test("anthropicResumableCodec.finalResponse emits tool_use blocks", () => {
  const json = anthropicResumableCodec.finalResponse({
    text: "Let me check",
    id: "msg_1",
    model: "m",
    finishReason: null,
    wantsStream: false,
    completionTokens: 4,
    promptTokens: 5,
    toolCalls: [
      { id: "toolu_1", name: "get_weather", arguments: '{"city":"Moscow"}' },
    ],
  });
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.stop_reason, "tool_use");
  assert.deepEqual(parsed.content, [
    { type: "text", text: "Let me check" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: { city: "Moscow" },
    },
  ]);

  const sse = anthropicResumableCodec.finalResponse({
    text: "",
    id: "msg_1",
    model: "m",
    finishReason: null,
    wantsStream: true,
    completionTokens: 4,
    promptTokens: 5,
    toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: "{}" }],
  });
  assert.match(
    sse.body,
    /"type":"tool_use","id":"toolu_1","name":"get_weather"/,
  );
  assert.match(sse.body, /"stop_reason":"tool_use"/);
});

test("anthropicProtocolAdapter forwards messages to llama-server upstream", () => {
  assert.equal(
    anthropicProtocolAdapter.upstreamPath(operation),
    "/v1/messages",
  );
  assert.equal(
    anthropicProtocolAdapter.upstreamPath({
      ...operation,
      endpoint: "messages.count_tokens",
      routePath: "/v1/messages/count_tokens",
    }),
    "/v1/messages/count_tokens",
  );
  assert.equal(
    anthropicProtocolAdapter.upstreamPath({
      ...operation,
      endpoint: "unknown",
      routePath: "/v1/unknown",
    }),
    null,
  );
});
