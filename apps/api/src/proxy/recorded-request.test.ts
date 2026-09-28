import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import type { Instance, InstanceKind } from "@arriero/core";

import { config } from "../config.js";
import { createInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { resetConfigFilesCache } from "./config-files.js";
import { recordedRequestPreparer } from "./recorded-request.js";
import { countInstancePromptTokens } from "./token-count.js";

const { uniqueName, seedBinaryRef, binaryRefId } =
  instanceTestFixture("recorded-request");

function instance(kind: InstanceKind): Instance {
  if (!binaryRefId()) seedBinaryRef();
  return createInstance({
    name: uniqueName(kind),
    kind,
    binaryPathRefId: binaryRefId(),
    rpcWorkers: [],
    args:
      kind === "vllm" || kind === "sglang"
        ? { "--served-model-name": "served-model" }
        : { "--alias": "local-model" },
    env: {},
    memory: [],
  });
}

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

const anthropicBody = {
  model: "claude-public",
  max_tokens: 1024,
  stream: true,
  system: [{ type: "text", text: "You are a coding agent." }],
  tools: [
    { name: "read", input_schema: { type: "object", properties: {} } },
    { name: "write", input_schema: { type: "object", properties: {} } },
  ],
  tool_choice: { type: "tool", name: "read" },
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
};

test("an OpenAI record passes through with the instance's model", () => {
  const prepared = recordedRequestPreparer(instance("vllm"))({
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    body: {
      model: "public",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.ok(prepared.ok);
  assert.equal(prepared.request.path, "/v1/chat/completions");
  assert.equal(prepared.request.body.model, "served-model");
  assert.deepEqual(prepared.request.body.messages, [
    { role: "user", content: "hi" },
  ]);
});

test("an Anthropic record is translated in the dialect of the target engine", () => {
  const llama = recordedRequestPreparer(instance("llama-server"))({
    protocol: "anthropic",
    endpoint: "messages",
    routePath: "/v1/messages",
    body: anthropicBody,
  });
  const vllm = recordedRequestPreparer(instance("vllm"))({
    protocol: "anthropic",
    endpoint: "messages",
    routePath: "/v1/messages",
    body: anthropicBody,
  });
  assert.ok(llama.ok && vllm.ok);
  assert.equal(llama.request.path, "/v1/chat/completions");
  assert.equal(vllm.request.path, "/v1/chat/completions");
  const llamaMessages = llama.request.body.messages as Array<{ role: string }>;
  assert.equal(llamaMessages[0]?.role, "system");
  assert.equal((llama.request.body.tools as unknown[]).length, 1);
  assert.equal(llama.request.body.tool_choice, "required");
  assert.equal((vllm.request.body.tools as unknown[]).length, 2);
  assert.deepEqual(vllm.request.body.tool_choice, {
    type: "function",
    function: { name: "read" },
  });
  assert.equal(llama.request.omittedCacheReadIsZero, false);
});

test("an operation outside the proxy is refused", () => {
  const prepared = recordedRequestPreparer(instance("vllm"))({
    protocol: "openai",
    endpoint: "unknown.operation",
    routePath: "/v1/unknown",
    body: {},
  });
  assert.equal(prepared.ok, false);
});

test("prompt tokens are counted against an instance directly", async () => {
  const calls: string[] = [];
  const result = await countInstancePromptTokens(
    instance("llama-server"),
    {
      operation: {
        protocol: "openai",
        endpoint: "chat.completions",
        routePath: "/v1/chat/completions",
        transport: "http-json",
      },
      body: { model: "public", messages: [{ role: "user", content: "hi" }] },
    },
    {
      fetchImpl: async (url, init = {}) => {
        calls.push(`${init.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return Response.json(
          init.method === "POST"
            ? { input_tokens: 42 }
            : { is_sleeping: false },
        );
      },
    },
  );
  assert.ok(result.ok && "tokens" in result);
  assert.equal(result.tokens, 42);
  assert.deepEqual(calls, [
    "GET /props",
    "POST /v1/chat/completions/input_tokens",
  ]);
});
