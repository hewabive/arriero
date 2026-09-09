import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";
import {
  ApiEndpointCreateSchema,
  ApiProxyModelRecordSchema,
  ApiProxyTargetCreateSchema,
  type InstanceKind,
} from "@arriero/core";

import { config } from "../config.js";
import { createInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint, instanceEndpointId } from "./endpoints.js";
import type { ApiProxyProtocolModelRequest } from "./protocol.js";
import { createApiProxyTarget } from "./repository.js";
import { createApiProxyTokenCounter } from "./token-count.js";

const { uniqueName, seedBinaryRef, binaryRefId } =
  instanceTestFixture("token-count");

function managedTarget(kind: InstanceKind) {
  if (!binaryRefId()) seedBinaryRef();
  const instance = createInstance({
    name: uniqueName(kind),
    kind,
    binaryPathRefId: binaryRefId(),
    rpcWorkers: [],
    args: {},
    env: {},
    memory: [],
    ...(kind === "ktransformers"
      ? {
          engineConfig: {
            type: "ktransformers" as const,
            model: "test-model",
            cpuWeights: "/weights",
            method: "BF16" as const,
          },
        }
      : {}),
  });
  return createApiProxyTarget(
    ApiProxyTargetCreateSchema.parse({
      name: instance.name,
      endpointId: instanceEndpointId(instance.name),
      model: "served-model",
    }),
  );
}

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
  assert.ok(result.ok && "tokens" in result);
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
  for (const kind of ["sglang", "vllm"] as const) {
    const result = await counter(request(imageBody), managedTarget(kind).id);
    assert.ok(!result.ok);
    assert.match(result.reason, /does not support this chat content/);
  }
  for (const content of [
    [{ type: "image_url", image_url: {} }],
    [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }],
    [{ type: "unknown", text: "unrecognized" }],
  ]) {
    assert.equal(
      (await counter(request({ messages: [{ role: "user", content }] }), a.id))
        .ok,
      false,
    );
  }
});

test("llama counts native images and Anthropic tool-result screenshots with the forwarding translation", async () => {
  const imageUrl = "data:image/png;base64,AAA";
  const imagePart = { type: "image_url", image_url: { url: imageUrl } };
  for (const a of [target(), managedTarget("llama-server")]) {
    for (const protocol of ["openai", "anthropic"] as const) {
      const body =
        protocol === "openai"
          ? {
              model: "public",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "screenshot" }, imagePart],
                },
              ],
            }
          : {
              model: "public",
              system: "system instruction",
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "inspect screenshot" },
                    {
                      type: "tool_use",
                      id: "call-1",
                      name: "screenshot",
                      input: { page: 1 },
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "call-1",
                      content: [
                        { type: "text", text: "screenshot" },
                        {
                          type: "image",
                          source: {
                            type: "base64",
                            media_type: "image/png",
                            data: "AAA",
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            };
      const original = structuredClone(body);
      let posts = 0;
      const counter = createApiProxyTokenCounter({
        fetchImpl: async (_, init) => {
          if (init?.method !== "POST")
            return Response.json({ is_sleeping: false });
          posts += 1;
          const counted = JSON.parse(String(init.body));
          assert.equal(counted.model, a.model);
          const messages = counted.messages as Record<string, unknown>[];
          assert.ok(
            messages.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some(
                  (part) => JSON.stringify(part) === JSON.stringify(imagePart),
                ),
            ),
          );
          if (protocol === "anthropic") {
            assert.equal(messages[0]?.content, "system instruction");
            assert.equal(messages[1]?.reasoning_content, "inspect screenshot");
            assert.equal(messages[2]?.role, "tool");
            assert.equal(messages[2]?.content, "screenshot");
          }
          return Response.json({ input_tokens: 223_712 });
        },
      });
      const result = await counter(request(body, protocol), a.id);
      assert.ok(result.ok && "tokens" in result);
      assert.equal(result.tokens, 223_712);
      assert.equal(posts, 1);
      assert.deepEqual(body, original);
    }
  }
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

for (const kind of ["sglang", "vllm"] as const) {
  test(`${kind} counts prepared chat without readiness or generation calls and caches concurrent probes`, async () => {
    const a = managedTarget(kind);
    const calls: { url: URL; body: Record<string, unknown> }[] = [];
    const counter = createApiProxyTokenCounter({
      fetchImpl: async (url, init) => {
        assert.equal(init?.method, "POST");
        assert.equal(init.redirect, "error");
        assert.ok(init.signal);
        calls.push({
          url: new URL(String(url)),
          body: JSON.parse(String(init.body)),
        });
        return Response.json(
          kind === "sglang" ? { count: 3 } : { token_ids: [1, 7, 12] },
        );
      },
    });
    const body = {
      model: "public",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: "none",
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: true },
      continue_final_message: true,
      add_generation_prompt: false,
      max_tokens: 20,
      stream: true,
      stream_options: { include_usage: true },
    };
    const input = request(body);
    const [first, second] = await Promise.all([
      counter(input, a.id),
      counter(input, a.id),
    ]);
    assert.deepEqual(first, second);
    assert.ok(first.ok && "tokens" in first);
    assert.equal(first.tokens, 3);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url.pathname,
      kind === "sglang" ? "/v1/tokenize" : "/v1/chat/completions/render",
    );
    assert.equal(calls[0]?.url.search, "");
    const { stream_options, ...expected } = body;
    assert.deepEqual(calls[0]?.body, {
      ...expected,
      model: "served-model",
      stream: false,
    });
    assert.deepEqual(body.stream_options, stream_options);
    assert.equal(body.stream, true);
    await counter(request({ ...body, reasoning_effort: "low" }), a.id);
    assert.equal(calls.length, 2);
  });

  test(`${kind} counts Anthropic messages after translation using its upstream dialect`, async () => {
    const a = managedTarget(kind);
    const counter = createApiProxyTokenCounter({
      fetchImpl: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "served-model");
        assert.equal(body.system, undefined);
        assert.equal(body.messages[0].role, "system");
        assert.equal(body.messages[0].content, "instruction");
        assert.equal(body.tools[0].function.name, "lookup");
        assert.deepEqual(body.tool_choice, {
          type: "function",
          function: { name: "lookup" },
        });
        assert.equal(body.stream, false);
        return Response.json(
          kind === "sglang" ? { count: 2 } : { token_ids: [1, 2] },
        );
      },
    });
    const result = await counter(
      request(
        {
          model: "public",
          system: "instruction",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ name: "lookup", input_schema: { type: "object" } }],
          tool_choice: { type: "tool", name: "lookup" },
          max_tokens: 20,
          stream: true,
        },
        "anthropic",
      ),
      a.id,
    );
    assert.ok(result.ok && "tokens" in result);
    assert.equal(result.tokens, 2);
  });

  test(`${kind} rejects invalid responses and unavailable endpoints without alternate probes`, async () => {
    const a = managedTarget(kind);
    const invalid =
      kind === "sglang"
        ? [{ count: -1 }, { count: 1.5 }, { count: "20" }, { count: [20] }, {}]
        : [
            { token_ids: null },
            { token_ids: "20" },
            { token_ids: [-1] },
            { token_ids: [1.5] },
            { token_ids: ["1"] },
            { count: 20 },
          ];
    for (const body of invalid) {
      const counter = createApiProxyTokenCounter({
        fetchImpl: async () => Response.json(body),
      });
      const result = await counter(request(), a.id);
      assert.ok(!result.ok);
      assert.match(result.reason, /invalid/);
    }
    for (const status of [404, 501, 503]) {
      let calls = 0;
      const counter = createApiProxyTokenCounter({
        fetchImpl: async () => {
          calls++;
          return new Response("unavailable", { status });
        },
      });
      const result = await counter(request(), a.id);
      assert.ok(!result.ok);
      assert.match(result.reason, new RegExp(`HTTP ${status}`));
      assert.equal(calls, 1);
    }
  });

  test(`${kind} propagates client cancellation to the counting POST`, async () => {
    const a = managedTarget(kind);
    const controller = new AbortController();
    controller.abort();
    const counter = createApiProxyTokenCounter({
      signal: controller.signal,
      fetchImpl: async (_, init) => {
        assert.equal(init?.method, "POST");
        assert.ok(init.signal?.aborted);
        init.signal.throwIfAborted();
        assert.fail("must abort");
      },
    });
    const result = await counter(request(), a.id);
    assert.ok(!result.ok);
    assert.match(result.reason, /cancelled/);
  });
}

function overflowMessage(qualifier = "at least ") {
  return `This model's maximum context length is 100 tokens. However, you requested 10 output tokens and your prompt contains ${qualifier}91 input tokens, for a total of ${qualifier}101 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=91)`;
}

test("vLLM overflow retains only a confirmed prompt bound, never the total or a fabricated exact count", async () => {
  const a = managedTarget("vllm");
  for (const qualifier of ["at least ", ""]) {
    const counter = createApiProxyTokenCounter({
      fetchImpl: async () =>
        Response.json(
          {
            error: {
              type: "BadRequestError",
              code: 400,
              param: "input_tokens",
              message: overflowMessage(qualifier),
            },
          },
          { status: 400 },
        ),
    });
    const result = await counter(request(), a.id);
    assert.ok(result.ok && "minimumTokens" in result);
    assert.equal(result.minimumTokens, 91);
    assert.equal("tokens" in result, false);
    assert.match(result.detail, /at least 91.*vLLM/);
  }
});

test("vLLM ignores unrelated, inconsistent and unrecognized validation errors", async () => {
  const a = managedTarget("vllm");
  const error = {
    type: "BadRequestError",
    code: 400,
    param: "input_tokens",
    message: overflowMessage(),
  };
  for (const changed of [
    { param: "max_tokens" },
    { type: "InternalServerError" },
    { code: 500 },
    { message: "maximum context length exceeded" },
    { message: error.message.replace("value=91", "value=99") },
    {
      message: error.message.replace(
        "total of at least 101",
        "total of at least 100",
      ),
    },
    { message: error.message.replace("length is 100", "length is 200") },
    { message: error.message.replace("total of at least", "total of") },
  ]) {
    const counter = createApiProxyTokenCounter({
      fetchImpl: async () =>
        Response.json({ error: { ...error, ...changed } }, { status: 400 }),
    });
    const result = await counter(request(), a.id);
    assert.ok(!result.ok);
    assert.match(result.reason, /without a recognized prompt bound/);
  }
});

test("KTransformers stays unsupported and managed multimodal requests never probe", async () => {
  const counter = createApiProxyTokenCounter({
    fetchImpl: async () => assert.fail("must not probe"),
  });
  const kt = managedTarget("ktransformers");
  assert.equal((await counter(request(), kt.id)).ok, false);
  for (const kind of ["sglang", "vllm"] as const) {
    const a = managedTarget(kind);
    assert.equal(
      (
        await counter(
          request({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "http://image.local" },
                  },
                ],
              },
            ],
          }),
          a.id,
        )
      ).ok,
      false,
    );
  }
});
