import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";
import {
  ApiEndpointCreateSchema,
  ApiProxyModelRecordSchema,
  ApiProxyTargetCreateSchema,
} from "@arriero/core";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint } from "./endpoints.js";
import type { ApiProxyProtocolModelRequest } from "./protocol.js";
import { createApiProxyTarget } from "./repository.js";
import { createApiProxyTokenCounter } from "./token-count.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

function target(profile = "llama-native", model = "actual-model") {
  const endpoint = createApiEndpoint(
    ApiEndpointCreateSchema.parse({
      name: `endpoint-${model}`,
      baseUrl: "http://upstream.local/prefix/v1",
      profile,
      apiKey: "test-key",
    }),
  );
  return createApiProxyTarget(
    ApiProxyTargetCreateSchema.parse({
      name: model,
      endpointId: endpoint.id,
      model,
    }),
  );
}

function request(
  body: unknown = {
    model: "public",
    messages: [{ role: "user", content: "hello" }],
  },
  protocol: "openai" | "anthropic" = "openai",
): ApiProxyProtocolModelRequest {
  return {
    operation: {
      protocol,
      endpoint: protocol === "openai" ? "chat.completions" : "messages",
      routePath: "/v1/chat/completions",
      transport: "http-json",
    },
    body,
    modelId: "public",
    model: ApiProxyModelRecordSchema.parse({ id: "model", modelId: "public" }),
    stream: false,
  };
}

test("llama counter uses model override, authentication, subpath and autoload=false; memoizes per target and body", async () => {
  const a = target();
  const b = target("llama-native", "other-model");
  const calls: { url: URL; init: RequestInit }[] = [];
  const counter = createApiProxyTokenCounter({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: new URL(String(url)), init });
      return Response.json(
        init.method === "POST" ? { input_tokens: 17 } : { is_sleeping: false },
      );
    },
  });
  const input = request();
  assert.deepEqual(await counter(input, a.id), await counter(input, a.id));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url.pathname, "/prefix/props");
  assert.equal(calls[0]?.url.searchParams.get("model"), "actual-model");
  assert.equal(
    calls[1]?.url.pathname,
    "/prefix/v1/chat/completions/input_tokens",
  );
  assert.equal(JSON.parse(String(calls[1]?.init.body)).model, "actual-model");
  for (const call of calls) {
    assert.equal(call.url.searchParams.get("autoload"), "false");
    assert.equal(
      new Headers(call.init.headers).get("authorization"),
      "Bearer test-key",
    );
    assert.equal(call.init.redirect, "error");
  }
  await counter(
    request({
      model: "public",
      messages: [{ role: "user", content: "changed" }],
    }),
    a.id,
  );
  await counter(input, b.id);
  assert.equal(calls.length, 6);
  const result = await counter(input, a.id);
  assert.ok(result.ok);
  assert.equal(result.tokens, 17);
  assert.match(result.detail, /actual-model/);
  assert.equal((input.body as { model: string }).model, "public");
});

test("Anthropic counting uses the same OpenAI bridge, preserving system and tool arguments", async () => {
  const a = target();
  let counted: Record<string, unknown> | null = null;
  const counter = createApiProxyTokenCounter({
    fetchImpl: async (_, init) => {
      if (init?.method !== "POST") return Response.json({ is_sleeping: false });
      counted = JSON.parse(String(init.body));
      return Response.json({ input_tokens: 501 });
    },
  });
  const body = {
    model: "public",
    max_tokens: 100,
    system: "system instruction",
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
    messages: [
      { role: "user", content: "look up hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "lookup",
            input: { value: "hello" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "found" },
        ],
      },
    ],
  };
  assert.ok((await counter(request(body, "anthropic"), a.id)).ok);
  const forwarded = counted as unknown as {
    model: string;
    system?: string;
    messages: {
      role: string;
      content: string;
      tool_calls?: { function: { arguments: string } }[];
    }[];
    tools: { type: string }[];
  };
  assert.equal(forwarded.model, "actual-model");
  assert.equal(forwarded.system, undefined);
  assert.equal(forwarded.messages[0]?.role, "system");
  assert.equal(forwarded.messages[0]?.content, "system instruction");
  assert.equal(forwarded.tools[0]?.type, "function");
  assert.equal(
    forwarded.messages[2]?.tool_calls?.[0]?.function.arguments,
    '{"value":"hello"}',
  );
  assert.equal(forwarded.messages[3]?.role, "tool");
});

test("sleeping, unloaded, and unrecognized readiness never send a counting POST", async () => {
  const a = target();
  for (const props of [
    { is_sleeping: true },
    {},
    { is_sleeping: false, error: true },
  ]) {
    let calls = 0;
    const counter = createApiProxyTokenCounter({
      fetchImpl: async (_, init) => {
        calls++;
        assert.notEqual(init?.method, "POST");
        return Response.json(props, { status: "error" in props ? 400 : 200 });
      },
    });
    const result = await counter(request(), a.id);
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test("unsupported engines, operations and multimodal requests do not probe upstream", async () => {
  const a = target();
  const b = target("openai", "unsupported");
  const counter = createApiProxyTokenCounter({
    fetchImpl: async () => {
      assert.fail("must not access upstream");
    },
  });
  assert.equal((await counter(request(), b.id)).ok, false);
  assert.equal(
    (
      await counter(
        {
          ...request(),
          operation: { ...request().operation, endpoint: "responses" },
        },
        a.id,
      )
    ).ok,
    false,
  );
  const imageBody = {
    model: "public",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "http://image.local" } },
        ],
      },
    ],
  };
  assert.equal((await counter(request(imageBody), a.id)).ok, false);
});

test("invalid counts, unsupported endpoint, and network failures return typed unavailable results", async () => {
  const a = target();
  for (const value of [-1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1]) {
    const counter = createApiProxyTokenCounter({
      fetchImpl: async (_, init) =>
        Response.json(
          init?.method === "POST"
            ? { input_tokens: value }
            : { is_sleeping: false },
        ),
    });
    const result = await counter(request(), a.id);
    assert.ok(!result.ok);
    assert.match(result.reason, /invalid input_tokens/);
  }
  const unavailable = createApiProxyTokenCounter({
    fetchImpl: async (_, init) =>
      init?.method === "POST"
        ? new Response("missing", { status: 404 })
        : Response.json({ is_sleeping: false }),
  });
  const result = await unavailable(request(), a.id);
  assert.ok(!result.ok);
  assert.match(result.reason, /HTTP 404/);
  const failed = createApiProxyTokenCounter({
    fetchImpl: async () => {
      throw new TypeError("secret URL must not leak");
    },
  });
  const failure = await failed(request(), a.id);
  assert.ok(!failure.ok);
  assert.match(failure.reason, /request failed/);
  assert.doesNotMatch(failure.reason, /secret URL/);
});

test("cancellation propagates to the readiness request and does not post", async () => {
  const controller = new AbortController();
  controller.abort();
  const a = target();
  const counter = createApiProxyTokenCounter({
    signal: controller.signal,
    fetchImpl: async (_, init) => {
      assert.notEqual(init?.method, "POST");
      assert.ok(init?.signal?.aborted);
      init.signal.throwIfAborted();
      assert.fail("aborted signal should throw");
    },
  });
  const result = await counter(request(), a.id);
  assert.ok(!result.ok);
  assert.match(result.reason, /cancelled/);
});
