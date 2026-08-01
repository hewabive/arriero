import assert from "node:assert/strict";
import test from "node:test";

import type { ApiProxyProtocolOperation } from "./protocol.js";
import {
  createApiProxyTokenScaleStream,
  scaleApiProxyRequestTokenCount,
  scaleApiProxyRequestTokens,
  scaleApiProxyResponseTokenCount,
  scaleApiProxyResponseTokenText,
  scaleApiProxyResponseTokens,
} from "./token-scale.js";

const openAiChat: ApiProxyProtocolOperation = {
  protocol: "openai",
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json",
};

const anthropicCount: ApiProxyProtocolOperation = {
  protocol: "anthropic",
  endpoint: "messages.count_tokens",
  routePath: "/v1/messages/count_tokens",
  transport: "http-json",
};

test("token count rounding is conservative in both directions", () => {
  assert.equal(scaleApiProxyRequestTokenCount(40_000, 10), 4_000);
  assert.equal(scaleApiProxyRequestTokenCount(40_000, 0.5), 80_000);
  assert.equal(scaleApiProxyRequestTokenCount(10, 3), 3);
  assert.equal(scaleApiProxyRequestTokenCount(1, 10), 1);
  assert.equal(scaleApiProxyRequestTokenCount(0, 10), 0);
  assert.equal(scaleApiProxyRequestTokenCount(-1, 10), -1);

  assert.equal(scaleApiProxyResponseTokenCount(10_000, 10), 100_000);
  assert.equal(scaleApiProxyResponseTokenCount(10_000, 0.5), 5_000);
  assert.equal(scaleApiProxyResponseTokenCount(10, 0.25), 3);
  assert.equal(scaleApiProxyResponseTokenCount(0, 0.25), 0);
  assert.equal(scaleApiProxyResponseTokenCount(-2, 10), -2);
});

test("request scaling covers OpenAI, Anthropic, and common local limits", () => {
  const original = {
    max_tokens: 40_000,
    max_completion_tokens: 20_001,
    max_output_tokens: 8_192,
    max_new_tokens: 1,
    n_predict: -1,
    thinking: { type: "enabled", budget_tokens: 12_345 },
    reasoning: { max_tokens: 2_001 },
    messages: [{ role: "user", content: "keep 40000 unchanged" }],
  };
  const result = scaleApiProxyRequestTokens(original, 10);

  assert.equal(result.count, 5);
  assert.notEqual(result.value, original);
  assert.deepEqual(result.value, {
    max_tokens: 4_000,
    max_completion_tokens: 2_000,
    max_output_tokens: 819,
    max_new_tokens: 1,
    n_predict: -1,
    thinking: { type: "enabled", budget_tokens: 1_234 },
    reasoning: { max_tokens: 200 },
    messages: [{ role: "user", content: "keep 40000 unchanged" }],
  });
  assert.equal(original.max_tokens, 40_000);
  assert.equal(original.thinking.budget_tokens, 12_345);
});

test("response scaling recursively covers standard usage token fields", () => {
  const body = {
    usage: {
      prompt_tokens: 10_000,
      completion_tokens: 2_000,
      total_tokens: 12_000,
      prompt_tokens_details: { cached_tokens: 7_500 },
      completion_tokens_details: {
        reasoning_tokens: 500,
        accepted_prediction_tokens: 20,
      },
    },
  };
  const result = scaleApiProxyResponseTokens({
    value: body,
    factor: 10,
    operation: openAiChat,
  });
  assert.equal(result.count, 6);
  assert.deepEqual(body.usage, {
    prompt_tokens: 100_000,
    completion_tokens: 20_000,
    total_tokens: 120_000,
    prompt_tokens_details: { cached_tokens: 75_000 },
    completion_tokens_details: {
      reasoning_tokens: 5_000,
      accepted_prediction_tokens: 200,
    },
  });
});

test("Anthropic count_tokens scales its top-level result", () => {
  const body = { input_tokens: 12_345 };
  const result = scaleApiProxyResponseTokens({
    value: body,
    factor: 0.5,
    operation: anthropicCount,
  });
  assert.equal(result.count, 1);
  assert.deepEqual(body, { input_tokens: 6_173 });
});

test("buffered SSE usage scales without changing other frames", () => {
  const original =
    ": ping\r\n\r\n" +
    'data: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10000,"completion_tokens":2000,"total_tokens":12000}}\r\n\r\n' +
    "data: [DONE]\r\n\r\n";
  const result = scaleApiProxyResponseTokenText({
    text: original,
    factor: 10,
    operation: openAiChat,
    isSse: true,
  });
  assert.equal(result.count, 3);
  assert.ok(result.text.startsWith(": ping\r\n\r\n"));
  assert.ok(result.text.includes('"content":"hello"'));
  assert.ok(
    result.text.includes(
      '"usage":{"prompt_tokens":100000,"completion_tokens":20000,"total_tokens":120000}',
    ),
  );
  assert.ok(result.text.endsWith("data: [DONE]\r\n\r\n"));
});

test("streaming scale preserves chunk delivery and rewrites usage frames", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        ),
      );
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      createApiProxyTokenScaleStream({ factor: 0.5, operation: openAiChat }),
    )
    .getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }
  assert.ok(output.includes('"content":"hi"'));
  assert.ok(
    output.includes(
      '"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":2}',
    ),
  );
});
