import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProxyTrace,
  errorBodyMessage,
  recordUpstreamErrorBody,
  upstreamErrorText,
} from "./protocol-trace.js";

const sglangNotFound = {
  object: "error",
  message: "The model qwen-missing does not exist.",
  type: "NotFoundError",
  param: null,
  code: 404,
};

const envelopes = [
  {
    name: "SGLang flat envelope",
    body: sglangNotFound,
    expected: "The model qwen-missing does not exist.",
  },
  {
    name: "vLLM nested envelope",
    body: {
      error: {
        message: "max_tokens must be at least 1, got 0.",
        type: "BadRequestError",
        param: null,
        code: 400,
      },
    },
    expected: "max_tokens must be at least 1, got 0.",
  },
  {
    name: "llama.cpp nested envelope",
    body: {
      error: {
        code: 400,
        message: "the request exceeds the available context size",
        type: "exceed_context_size_error",
        n_prompt_tokens: 9000,
        n_ctx: 8192,
      },
    },
    expected: "the request exceeds the available context size",
  },
  {
    name: "string error envelope",
    body: { error: "Model not loaded" },
    expected: "Model not loaded",
  },
];

for (const envelope of envelopes) {
  test(`upstreamErrorText reads the message of a ${envelope.name}`, () => {
    assert.equal(
      upstreamErrorText(JSON.stringify(envelope.body)),
      envelope.expected,
    );
  });
}

test("upstreamErrorText falls back to the raw body when no message is set", () => {
  for (const body of [
    { error: { message: "   " } },
    { error: { message: "" }, message: "shadowed" },
    { object: "error", message: "" },
    { error: "" },
    { error: { code: 500 } },
  ]) {
    const text = JSON.stringify(body);
    assert.equal(upstreamErrorText(text), text);
  }
});

test("upstreamErrorText keeps a non-JSON body as raw text capped at 500 chars", () => {
  assert.equal(
    upstreamErrorText("Internal Server Error"),
    "Internal Server Error",
  );
  assert.equal(upstreamErrorText("x".repeat(800)), "x".repeat(500));
});

test("errorBodyMessage reads only structured bodies", () => {
  assert.equal(errorBodyMessage("plain upstream text"), null);
  assert.equal(errorBodyMessage(null), null);
  assert.equal(errorBodyMessage(sglangNotFound), sglangNotFound.message);
});

test("recordUpstreamErrorBody traces the message of a flat upstream envelope", () => {
  const trace = createProxyTrace({
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    transport: "http-json",
  });
  recordUpstreamErrorBody(
    trace,
    "openai",
    JSON.stringify(sglangNotFound),
    false,
  );
  assert.equal(trace.errorMessage, sglangNotFound.message);
});
