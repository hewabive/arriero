import { ApiLabProbeTargetRequestSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { apiLabProbeTargetFromBaseUrl } from "./probe.js";

test("apiLabProbeTargetFromBaseUrl builds OpenAI endpoints relative to a /v1 base URL", () => {
  const target = apiLabProbeTargetFromBaseUrl(
    "openai",
    "http://127.0.0.1:8787/v1",
    {
      kind: "chat",
      prompt: "Hello",
      maxTokens: 4,
      temperature: 0.1,
      autoload: true,
    },
  );

  assert.equal(target.endpoint, "/chat/completions");
  assert.equal(target.url, "http://127.0.0.1:8787/v1/chat/completions");
  assert.deepEqual(target.requestBody, {
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 4,
    temperature: 0.1,
    stream: false,
  });
});

test("apiLabProbeTargetFromBaseUrl keeps llama.cpp native endpoints at server root with autoload", () => {
  const target = apiLabProbeTargetFromBaseUrl(
    "llama-native",
    "http://127.0.0.1:8080",
    {
      kind: "tokenize",
      prompt: "Hello",
      maxTokens: 4,
      temperature: 0.1,
      autoload: false,
    },
  );

  assert.equal(target.endpoint, "/tokenize?autoload=false");
  assert.equal(target.url, "http://127.0.0.1:8080/tokenize?autoload=false");
  assert.deepEqual(target.requestBody, {
    content: "Hello",
    with_pieces: true,
    add_special: false,
    parse_special: true,
  });
});

test("apiLabProbeTargetFromBaseUrl sends a chat probe to the Anthropic messages endpoint", () => {
  const target = apiLabProbeTargetFromBaseUrl(
    "anthropic",
    "https://api.anthropic.com/v1",
    {
      kind: "chat",
      model: "claude-sonnet-4-6",
      prompt: "Hello",
      systemPrompt: "Be terse.",
      maxTokens: 8,
      temperature: 0.1,
      autoload: true,
    },
    { stream: true },
  );

  assert.equal(target.endpoint, "/messages");
  assert.equal(target.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(target.requestBody, {
    system: "Be terse.",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 8,
    temperature: 0.1,
    stream: true,
    model: "claude-sonnet-4-6",
  });
});

test("ApiLabProbeTargetRequestSchema accepts a chat probe for the Anthropic profile", () => {
  const parsed = ApiLabProbeTargetRequestSchema.safeParse({
    profile: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    probe: {
      kind: "chat",
      prompt: "Hello",
      maxTokens: 4,
      temperature: 0.1,
      autoload: true,
    },
  });

  assert.equal(parsed.success, true);
});

test("ApiLabProbeTargetRequestSchema rejects probe kinds from another profile", () => {
  const parsed = ApiLabProbeTargetRequestSchema.safeParse({
    profile: "llama-native",
    baseUrl: "http://127.0.0.1:8080",
    probe: {
      kind: "chat",
      prompt: "Hello",
      maxTokens: 4,
      temperature: 0.1,
      autoload: true,
    },
  });

  assert.equal(parsed.success, false);
});
