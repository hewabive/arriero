import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, Server } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";

import { ApiProxyPipelineNodeSchema } from "@arriero/core";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { config } from "../config.js";
import { createNode } from "../nodes/repository.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint, remoteEndpointId } from "./endpoints.js";
import {
  registerAnthropicProxyRoutes,
  registerOpenAiProxyRoutes,
} from "./protocol-routes.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyTarget,
} from "./repository.js";
import { readApiProxyRequestFile } from "./request-files.js";
import { clearApiProxyResponseCache } from "./response-cache.js";
import { apiProxyStats } from "./stats.js";
import {
  clearApiProxyTraceHistory,
  listApiProxyTraces,
} from "./traces-repository.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  apiProxyStats.reset();
  clearApiProxyTraceHistory();
  clearApiProxyResponseCache();
});

function seedModel(modelId: string, enabled: boolean, blockedMessage = "") {
  return createApiProxyModel({
    modelId,
    visible: true,
    enabled,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
    blockedMessage,
  });
}

function buildApp(): Hono {
  const app = new Hono();
  registerOpenAiProxyRoutes(app, "/v1");
  registerAnthropicProxyRoutes(app, "/anthropic/v1");
  return app;
}

async function seedCapturedUpstream(
  t: TestContext,
  response: { status: number; contentType: string; body: string },
  options: {
    delegated?: boolean;
    profile?: "openai" | "anthropic";
    cache?: boolean;
    keepOpen?: boolean;
    streamIdleTimeoutMs?: number;
    abortAfterMs?: number;
  } = {},
) {
  let requests = 0;
  const server = createServer((request, reply) => {
    requests += 1;
    request.resume();
    reply.writeHead(response.status, { "content-type": response.contentType });
    if (options.keepOpen) {
      reply.write(response.body);
      if (options.abortAfterMs !== undefined) {
        const timer = setTimeout(() => reply.destroy(), options.abortAfterMs);
        reply.on("close", () => clearTimeout(timer));
      }
    } else {
      reply.end(response.body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let endpointId: string;
  if (options.delegated) {
    const node = createNode({ name: "capture-peer", baseUrl, enabled: true });
    endpointId = remoteEndpointId(node.id, "capture-instance");
  } else {
    const endpoint = createApiEndpoint({
      name: "capture-endpoint",
      baseUrl,
      profile: options.profile ?? "openai",
      reasoning: null,
      apiKeyEnvVar: null,
      authHeaderName: null,
      extraHeaders: {},
      passthrough: false,
      modelFilter: null,
      enabled: true,
      apiKey: "",
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? null,
    });
    endpointId = endpoint.id;
  }
  const target = createApiProxyTarget({
    name: "capture-target",
    endpointId,
    model: null,
    role: "interactive",
    priority: 100,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  });
  seedCapturedModel(target.id, options.cache);
  return { requests: () => requests };
}

function seedCapturedModel(targetId: string, cache = true) {
  const pipeline = createApiProxyPipeline({
    name: "capture-pipeline",
    enabled: true,
    entry: { type: "node", id: "capture" },
    nodes: [
      ApiProxyPipelineNodeSchema.parse({
        id: "capture",
        type: "capture-request",
        config: { request: true, response: true },
        ports: {
          next: cache
            ? { type: "node", id: "cache" }
            : { type: "target", id: targetId },
        },
      }),
      ...(cache
        ? [
            ApiProxyPipelineNodeSchema.parse({
              id: "cache",
              type: "cache",
              config: {},
              ports: { next: { type: "target", id: targetId } },
            }),
          ]
        : []),
    ],
  });
  createApiProxyModel({
    modelId: "captured-model",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: { type: "pipeline", id: pipeline.id },
    description: null,
    blockedMessage: "",
  });
}

function postCapturedRequest(
  app: Hono,
  protocol: "openai" | "anthropic",
  stream: boolean,
) {
  return app.request(
    protocol === "openai" ? "/v1/chat/completions" : "/anthropic/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "captured-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream,
      }),
    },
  );
}

const completeSse = [
  'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
  'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
  "data: [DONE]",
]
  .map((frame) => `${frame}\n\n`)
  .join("");

for (const failure of ["idle", "transport"] as const) {
  for (const route of [
    "external",
    "translated",
    "anthropic",
    "completions",
    "responses",
  ] as const) {
    test(`${route} sends an SSE error after ${failure} failure and never caches it`, async (t) => {
      const partial =
        route === "anthropic"
          ? 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
          : route === "responses"
            ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello","sequence_number":7}\n\n'
            : `${completeSse.split("\n\n")[0]}\n\n`;
      const upstream = await seedCapturedUpstream(
        t,
        {
          status: 200,
          contentType: "text/event-stream",
          body: `${partial}data: {"unfinished":`,
        },
        {
          profile: route === "anthropic" ? "anthropic" : "openai",
          keepOpen: true,
          streamIdleTimeoutMs: failure === "idle" ? 150 : 5_000,
          ...(failure === "transport" ? { abortAfterMs: 150 } : {}),
        },
      );
      const app = buildApp();
      const protocol =
        route === "translated" || route === "anthropic"
          ? "anthropic"
          : "openai";
      const path =
        protocol === "anthropic"
          ? "/anthropic/v1/messages"
          : route === "completions"
            ? "/v1/completions"
            : route === "responses"
              ? "/v1/responses"
              : "/v1/chat/completions";
      const server = serve({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      assert.ok(server instanceof Server);
      t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response: Response = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "captured-model",
              messages: [{ role: "user", content: "hi" }],
              prompt: "hi",
              max_tokens: 100,
              stream: true,
            }),
          },
        );
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.match(body, /Hello/);
        const code =
          failure === "idle"
            ? "arriero_proxy_upstream_timeout"
            : "arriero_proxy_upstream_error";
        assert.match(body, new RegExp(code));
        assert.doesNotMatch(
          body,
          /unfinished|"finish_reason":"stop"|message_stop/,
        );
        if (protocol === "openai" && route !== "responses")
          assert.ok(body.endsWith("data: [DONE]\n\n"));
        else assert.match(body, /event: error\n/);
        const payloads = body
          .split("\n")
          .filter((line) => line.startsWith("data: {"))
          .map(
            (line) =>
              JSON.parse(line.slice(6)) as {
                type?: string;
                message?: string;
                sequence_number?: number;
                error?: { message: string };
              },
          );
        const error =
          route === "responses"
            ? payloads.find((payload) => payload.type === "error")
            : payloads.find((payload) => payload.error)?.error;
        assert.ok(error);
        if (route === "responses")
          assert.equal(payloads.at(-1)?.sequence_number, 8);
        if (failure === "idle")
          assert.match(error.message ?? "", /upstream stream stalled/);
        const trace = listApiProxyTraces()[0];
        assert.ok(trace);
        assert.equal(trace.status, 200);
        assert.equal(trace.ok, false);
        assert.equal(trace.errorCode, code);
        assert.equal(trace.cache, null);
        assert.deepEqual(
          trace.files.map((file) => file.kind),
          ["capture-request", "capture-response"],
        );
        assert.equal(readApiProxyRequestFile(trace.files[1]!.path)?.data, body);
      }
      assert.equal(upstream.requests(), 2);
    });
  }
}

for (const route of ["external", "translated", "delegated"] as const) {
  test(`${route} captures SSE when the client cancels after the terminal before HTTP EOF`, async (t) => {
    await seedCapturedUpstream(
      t,
      {
        status: 200,
        contentType: "text/event-stream",
        body: completeSse,
      },
      { delegated: route === "delegated", cache: false, keepOpen: true },
    );
    const protocol = route === "translated" ? "anthropic" : "openai";
    const response = await postCapturedRequest(buildApp(), protocol, true);
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const terminal = route === "translated" ? "message_stop" : "[DONE]";
    let delivered = "";
    while (!delivered.includes(terminal)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      delivered += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const traces = listApiProxyTraces();
    assert.equal(traces.length, 1);
    const trace = traces[0]!;
    assert.equal(trace.status, 200);
    assert.equal(trace.usage?.promptTokens, 5);
    assert.equal(trace.usage?.completionTokens, 2);
    assert.equal(trace.streamHealth?.terminal, "done");
    assert.equal(trace.streamHealth.truncated, false);
    assert.equal(trace.cache, null);
    assert.deepEqual(
      trace.files.map((file) => file.kind),
      ["capture-request", "capture-response"],
    );
    assert.equal(
      readApiProxyRequestFile(trace.files[1]!.path)?.data,
      delivered,
    );
  });
}

for (const route of ["external", "translated", "delegated"] as const) {
  test(`${route} SSE persists the complete response and trace before replaying from cache`, async (t) => {
    const upstream = await seedCapturedUpstream(
      t,
      {
        status: 200,
        contentType: "text/event-stream",
        body: completeSse,
      },
      { delegated: route === "delegated" },
    );
    const app = buildApp();
    const protocol = route === "translated" ? "anthropic" : "openai";
    const response = await postCapturedRequest(app, protocol, true);
    assert.equal(response.status, 200);
    const delivered = await response.text();
    assert.match(delivered, /Hello/);
    assert.match(
      delivered,
      route === "translated" ? /message_stop/ : /\[DONE\]/,
    );
    const traces = listApiProxyTraces();
    assert.equal(traces.length, 1);
    const trace = traces[0]!;
    assert.equal(trace.status, 200);
    assert.equal(trace.usage?.completionTokens, 2);
    assert.equal(trace.streamHealth?.truncated, false);
    assert.equal(trace.cache, "store");
    assert.deepEqual(
      trace.files.map((file) => file.kind),
      ["capture-request", "capture-response"],
    );
    assert.equal(
      readApiProxyRequestFile(trace.files[1]!.path)?.data,
      delivered,
    );
    const cached = await postCapturedRequest(app, protocol, true);
    assert.equal(await cached.text(), delivered);
    assert.equal(upstream.requests(), 1);
  });
}

test("cancellation before a terminal retains usage without capturing an incomplete response", async (t) => {
  await seedCapturedUpstream(
    t,
    {
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    },
    { cache: false, keepOpen: true },
  );
  const response = await postCapturedRequest(buildApp(), "openai", true);
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const trace = listApiProxyTraces()[0]!;
  assert.equal(trace.usage?.completionTokens, 2);
  assert.equal(trace.streamHealth, null);
  assert.deepEqual(
    trace.files.map((file) => file.kind),
    ["capture-request"],
  );
});

test("a capture node also saves a proxy-generated gateway error", async () => {
  seedCapturedModel("missing-target");
  const response = await postCapturedRequest(buildApp(), "openai", false);
  assert.equal(response.status, 503);
  const delivered = await response.json();
  const trace = listApiProxyTraces()[0]!;
  assert.equal(trace.status, 503);
  assert.equal(trace.ok, false);
  assert.deepEqual(
    trace.files.map((file) => file.kind),
    ["capture-request", "capture-response"],
  );
  assert.deepEqual(
    readApiProxyRequestFile(trace.files[1]!.path)?.data,
    delivered,
  );
});

for (const route of ["external", "translated", "delegated"] as const) {
  for (const stream of [false, true]) {
    test(`${route} captures HTTP errors for stream=${stream} without caching them`, async (t) => {
      const error = {
        error: { type: "invalid_request_error", message: "missing request id" },
      };
      const upstream = await seedCapturedUpstream(
        t,
        {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify(error),
        },
        { delegated: route === "delegated" },
      );
      const app = buildApp();
      const protocol = route === "translated" ? "anthropic" : "openai";
      const response = await postCapturedRequest(app, protocol, stream);
      assert.equal(response.status, 400);
      const delivered = await response.json();
      const trace = listApiProxyTraces()[0]!;
      assert.equal(trace.status, 400);
      assert.equal(trace.ok, false);
      assert.equal(trace.errorMessage, "missing request id");
      assert.equal(trace.usage, null);
      assert.deepEqual(
        trace.files.map((file) => file.kind),
        ["capture-request", "capture-response"],
      );
      assert.deepEqual(
        readApiProxyRequestFile(trace.files[1]!.path)?.data,
        delivered,
      );
      const repeated = await postCapturedRequest(app, protocol, stream);
      assert.equal(repeated.status, 400);
      await repeated.text();
      assert.equal(upstream.requests(), 2);
    });
  }
}

for (const route of [
  "external",
  "translated",
  "delegated",
  "anthropic",
] as const) {
  for (const stream of [false, true]) {
    test(`${route} preserves token and cache usage on HTTP errors, stream=${stream}`, async (t) => {
      const nativeAnthropic = route === "anthropic";
      const usage = nativeAnthropic
        ? {
            input_tokens: 35,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 5,
            output_tokens: 7,
          }
        : {
            prompt_tokens: 120,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 80 },
          };
      await seedCapturedUpstream(
        t,
        {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "generation failed",
            },
            usage,
            timings: { predicted_ms: 350 },
          }),
        },
        {
          delegated: route === "delegated",
          profile: nativeAnthropic ? "anthropic" : "openai",
        },
      );
      const protocol =
        route === "translated" || nativeAnthropic ? "anthropic" : "openai";
      const response = await postCapturedRequest(buildApp(), protocol, stream);
      assert.equal(response.status, 400);
      await response.text();
      const trace = listApiProxyTraces()[0]!;
      assert.equal(trace.ok, false);
      assert.deepEqual(trace.usage, {
        promptTokens: 120,
        completionTokens: 7,
        cacheReadTokens: 80,
        cacheCreationTokens: nativeAnthropic ? 5 : null,
        genMs: 350,
        ratePerSecond: 20,
        prefillMs: null,
        promptPerSecond: null,
      });
    });
  }
}

async function postChatCompletion(
  app: Hono,
  modelId: string,
): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

test("a disabled model failure persists its diagnostic code on the trace", async () => {
  seedModel(
    "disabled-model",
    false,
    "Maintenance until 18:00 UTC. Use replacement-model.",
  );

  const response = await postChatCompletion(buildApp(), "disabled-model");
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-should-retry"), "false");
  const body = (await response.json()) as {
    error: { code: string; message: string; type: string };
  };
  assert.equal(body.error.code, "arriero_proxy_model_disabled");
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(
    body.error.message,
    "Maintenance until 18:00 UTC. Use replacement-model.",
  );

  const traces = listApiProxyTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.errorCode, "arriero_proxy_model_disabled");
  assert.equal(
    traces[0]?.errorMessage,
    "Maintenance until 18:00 UTC. Use replacement-model.",
  );
  assert.equal(traces[0]?.ok, false);
  assert.equal(traces[0]?.status, 409);
});

test("a disabled model without a custom message gets the default", async () => {
  seedModel("disabled-model", false);

  const response = await postChatCompletion(buildApp(), "disabled-model");
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(
    body.error.message,
    "Model disabled-model is disabled by the administrator.",
  );
});

test("an unbound model failure persists its route diagnostic code", async () => {
  seedModel("unbound-model", true);

  const response = await postChatCompletion(buildApp(), "unbound-model");
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "arriero_proxy_route_unbound");

  const traces = listApiProxyTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.errorCode, "arriero_proxy_route_unbound");
  assert.equal(traces[0]?.ok, false);
});
