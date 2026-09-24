import assert from "node:assert/strict";
import test from "node:test";

import { translateOpenAiError } from "./errors.js";
import { translateOpenAiResponse } from "./response.js";

test("translates text response with usage and cache details", () => {
  const result = translateOpenAiResponse({
    id: "chatcmpl-42",
    model: "qwen",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 60 },
    },
  });
  assert.deepEqual(result, {
    id: "msg_chatcmpl-42",
    type: "message",
    role: "assistant",
    model: "qwen",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 40,
      output_tokens: 7,
      cache_read_input_tokens: 60,
    },
  });
});

test("translates reasoning and tool calls", () => {
  const result = translateOpenAiResponse({
    id: "chatcmpl-1",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "think",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":1}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "think", signature: "" },
    { type: "tool_use", id: "call_1", name: "lookup", input: { q: 1 } },
  ]);
  assert.equal(result.stop_reason, "tool_use");
});

test("falls back to empty input on malformed tool arguments", () => {
  const result = translateOpenAiResponse({
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "f", arguments: "{broken" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  assert.deepEqual(result.content, [
    { type: "tool_use", id: "call_1", name: "f", input: {} },
  ]);
});

test("length maps to max_tokens and empty response yields empty text block", () => {
  const result = translateOpenAiResponse({
    choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
  });
  assert.equal(result.stop_reason, "max_tokens");
  assert.deepEqual(result.content, [{ type: "text", text: "" }]);
});

test("translates OpenAI errors to Anthropic error shape", () => {
  assert.deepEqual(
    translateOpenAiError(404, {
      error: { message: "no model", type: "not_found", code: null },
    }),
    {
      type: "error",
      error: { type: "not_found_error", message: "no model" },
    },
  );
  assert.deepEqual(translateOpenAiError(502, "bad gateway"), {
    type: "error",
    error: { type: "api_error", message: "bad gateway" },
  });
  assert.equal(translateOpenAiError(429, {}).error.type, "rate_limit_error");
});

test("preserves flat upstream error messages", () => {
  const message = "max_tokens must be greater than 0";
  assert.deepEqual(
    translateOpenAiError(400, {
      object: "error",
      message,
      type: "BadRequestError",
      code: 400,
    }),
    { type: "error", error: { type: "invalid_request_error", message } },
  );
});

test("nested error messages take precedence over top-level messages", () => {
  for (const error of [{ message: "nested" }, "nested"]) {
    assert.equal(
      translateOpenAiError(400, { error, message: "top-level" }).error.message,
      "nested",
    );
  }
});

test("malformed error bodies use a valid message or the status fallback", () => {
  assert.equal(
    translateOpenAiError(400, { error: { message: 42 }, message: "top-level" })
      .error.message,
    "top-level",
  );
  for (const body of [null, [], 42, {}, { message: 42 }, { message: {} }]) {
    assert.equal(
      translateOpenAiError(400, body).error.message,
      "Upstream responded with status 400.",
    );
  }
});
