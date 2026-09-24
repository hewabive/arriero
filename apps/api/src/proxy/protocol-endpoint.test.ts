import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, Server } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";

import { ApiProxyPipelineNodeSchema, type Instance } from "@arriero/core";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { config } from "../config.js";
import { createInstance, deleteInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import {
  buildLaunchSnapshot,
  serializeLaunchSnapshot,
} from "../process/launch-snapshot.js";
import {
  createProcessRun,
  updateProcessRun,
} from "../process/runs-repository.js";
import { createNode } from "../nodes/repository.js";
import { getApiProxyActivity } from "./activity.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  createApiEndpoint,
  instanceEndpointId,
  remoteEndpointId,
} from "./endpoints.js";
import { apiProxyInflight } from "./inflight.js";
import { executeApiProxyModelSubRequest } from "./fusion.js";
import {
  registerAnthropicProxyRoutes,
  registerOpenAiProxyRoutes,
} from "./protocol-routes.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyTarget,
  getApiProxyModelByModelId,
} from "./repository.js";
import { captureApiProxyResponseSse } from "./response-capture.js";
import { readApiProxyRequestFile } from "./request-files.js";
import { clearApiProxyResponseCache } from "./response-cache.js";
import { apiProxyStats } from "./stats.js";
import {
  clearApiProxyTraceHistory,
  listApiProxyTraces,
} from "./traces-repository.js";

const managedFixture = instanceTestFixture("proxy-cache-report");

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  apiProxyInflight.reset();
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
    managed?: {
      kind?: "sglang" | "llama-server" | "vllm";
      args?: Instance["args"];
      positionalArgs?: string[];
      configured: boolean;
      launched: boolean;
      snapshot?: boolean;
    };
    delegated?: boolean;
    profile?: "openai" | "anthropic";
    cache?: boolean;
    keepOpen?: boolean;
    streamIdleTimeoutMs?: number;
    abortAfterMs?: number;
    chunkDelayMs?: number;
    expectedModel?: string;
  } = {},
) {
  let requests = 0;
  const server = createServer(async (request, reply) => {
    requests += 1;
    if (options.expectedModel && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model !== options.expectedModel) {
        reply.writeHead(404, { "content-type": "application/json" });
        reply.end(
          JSON.stringify({
            error: {
              message: `The model ${body.model} does not exist.`,
              type: "NotFoundError",
              code: 404,
            },
          }),
        );
        return;
      }
    } else {
      request.resume();
    }
    reply.writeHead(response.status, { "content-type": response.contentType });
    if (options.chunkDelayMs !== undefined && request.method === "POST") {
      const frames = response.body.split("\n\n");
      const send = () => {
        const frame = frames.shift();
        if (frame === undefined) {
          reply.end();
          return;
        }
        reply.write(`${frame}\n\n`);
        const timer = setTimeout(send, options.chunkDelayMs);
        reply.once("close", () => clearTimeout(timer));
      };
      send();
    } else if (options.keepOpen) {
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
  if (options.managed) {
    const instance = createInstance({
      name: managedFixture.uniqueName("managed"),
      kind: options.managed.kind ?? "sglang",
      binaryPathRefId: managedFixture.seedBinaryRef(),
      args: {
        "--host": "127.0.0.1",
        "--port": address.port,
        "--enable-cache-report": options.managed.configured,
        ...options.managed.args,
      },
      positionalArgs: options.managed.positionalArgs ?? [],
      env: {},
      rpcWorkers: [],
      memory: [],
    });
    const runId = createProcessRun({
      instanceId: instance.name,
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      logPath: "",
      rawLogPath: null,
      launchSnapshot:
        options.managed.snapshot === false
          ? null
          : serializeLaunchSnapshot(
              buildLaunchSnapshot({
                ...instance,
                args: {
                  ...instance.args,
                  "--enable-cache-report": options.managed.launched,
                },
              }),
            ),
    });
    t.after(() => {
      updateProcessRun(runId, {
        status: "exited",
        stoppedAt: new Date().toISOString(),
      });
      deleteInstance(instance.name);
    });
    endpointId = instanceEndpointId(instance.name);
  } else if (options.delegated) {
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
  return { requests: () => requests, target };
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

for (const scenario of [
  {
    name: "served alias",
    args: { "--served-model-name": "qwen-local" },
    expected: "qwen-local",
  },
  {
    name: "first served alias",
    args: { "--served-model-name": ["qwen-local", "qwen-alternate"] },
    expected: "qwen-local",
  },
  { name: "positional model", args: {}, expected: "Qwen/Qwen3-8B" },
] satisfies { name: string; args: Instance["args"]; expected: string }[]) {
  for (const protocol of ["openai", "anthropic"] as const) {
    for (const stream of [false, true]) {
      test(`managed vLLM forwards ${scenario.name} for ${protocol} stream=${stream}`, async (t) => {
        const jsonResponse = protocol === "anthropic" && !stream;
        const upstream = await seedCapturedUpstream(
          t,
          {
            status: 200,
            contentType: jsonResponse
              ? "application/json"
              : "text/event-stream",
            body: jsonResponse
              ? JSON.stringify({
                  id: "chat-1",
                  model: scenario.expected,
                  choices: [
                    {
                      message: { role: "assistant", content: "Hello" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                })
              : [
                  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                  "data: [DONE]",
                  "",
                ].join("\n\n"),
          },
          {
            managed: {
              kind: "vllm",
              configured: false,
              launched: false,
              args: scenario.args,
              positionalArgs: ["Qwen/Qwen3-8B"],
            },
            cache: false,
            expectedModel: scenario.expected,
          },
        );
        const response = await buildApp().request(
          protocol === "openai"
            ? "/v1/chat/completions"
            : "/anthropic/v1/messages",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "captured-model",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 10,
              stream,
            }),
          },
        );
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.match(
          response.headers.get("content-type") ?? "",
          stream ? /text\/event-stream/ : /application\/json/,
        );
        assert.match(body, /Hello/);
        assert.ok(upstream.requests() > 0);
        assert.equal(upstream.target.model, null);
        assert.equal(listApiProxyTraces()[0]?.modelId, "captured-model");
        if (stream) {
          const model = getApiProxyModelByModelId("captured-model");
          assert.ok(model);
          const result = await executeApiProxyModelSubRequest({
            targetId: upstream.target.id,
            model,
            operation: {
              protocol,
              endpoint: protocol === "openai" ? "chat.completions" : "messages",
              routePath: "/v1/chat/completions",
              transport: "http-json",
            },
            body: {
              model: "captured-model",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 10,
            },
          });
          assert.ok(result.ok, JSON.stringify(result));
          assert.equal(result.state.text, "Hello");
        }
      });
    }
  }
}

function postCapturedRequest(
  app: Hono,
  protocol: "openai" | "anthropic",
  stream: boolean,
  extraBody: Record<string, unknown> = {},
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
        ...extraBody,
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

test(
  "silent live SSE remains visible until client cancellation",
  { timeout: 10_000 },
  async (t) => {
    await seedCapturedUpstream(
      t,
      {
        status: 200,
        contentType: "text/event-stream",
        body: `${completeSse.split("\n\n")[0]}\n\n: keepalive\n\n`,
      },
      { cache: false, keepOpen: true, streamIdleTimeoutMs: 0 },
    );
    const now = performance.now.bind(performance);
    let elapsed = 0;
    t.mock.method(performance, "now", () => now() + elapsed);
    const response = await postCapturedRequest(buildApp(), "openai", true);
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    try {
      assert.equal((await reader.read()).done, false);
      elapsed = 24 * 60 * 60 * 1000;
      const model = getApiProxyActivity().models.find(
        (entry) => entry.modelId === "captured-model",
      );
      assert.equal(model?.activeRequests, 1);
      assert.equal(apiProxyInflight.snapshotList()[0]?.phase, "generating");
      assert.equal(listApiProxyTraces().length, 0);
    } finally {
      await reader.cancel();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(apiProxyInflight.activeCount(), 0);
    assert.equal(listApiProxyTraces().length, 1);
    elapsed += 15_001;
    assert.deepEqual(apiProxyInflight.snapshotList(), []);
  },
);

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
        assert.deepEqual(
          readApiProxyRequestFile(trace.files[1]!.path)?.data,
          captureApiProxyResponseSse(body, {
            protocol: trace.protocol,
            endpoint: trace.endpoint,
            routePath: trace.routePath,
            transport: "sse",
          }),
        );
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
    assert.deepEqual(
      readApiProxyRequestFile(trace.files[1]!.path)?.data,
      captureApiProxyResponseSse(delivered, {
        protocol: trace.protocol,
        endpoint: trace.endpoint,
        routePath: trace.routePath,
        transport: "sse",
      }),
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
    assert.deepEqual(
      readApiProxyRequestFile(trace.files[1]!.path)?.data,
      captureApiProxyResponseSse(delivered, {
        protocol: trace.protocol,
        endpoint: trace.endpoint,
        routePath: trace.routePath,
        transport: "sse",
      }),
    );
    const cached = await postCapturedRequest(app, protocol, true);
    assert.equal(await cached.text(), delivered);
    assert.equal(upstream.requests(), 1);
  });
}

test("cancellation before a terminal retains usage and captures the partial response", async (t) => {
  const frame =
    'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n';
  await seedCapturedUpstream(
    t,
    { status: 200, contentType: "text/event-stream", body: frame },
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
    ["capture-request", "capture-response-partial"],
  );
  assert.deepEqual(
    readApiProxyRequestFile(trace.files[1]!.path)?.data,
    captureApiProxyResponseSse(frame, {
      protocol: "openai",
      endpoint: "chat.completions",
      routePath: trace.routePath,
      transport: "sse",
    }),
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

for (const protocol of ["openai", "anthropic"] as const) {
  for (const mode of ["json", "sse", "buffered"] as const) {
    if (protocol === "anthropic" && mode === "buffered") continue;
    test(`SGLang cold cache is recorded as zero for ${protocol} ${mode}`, async (t) => {
      const usage = {
        prompt_tokens: 120,
        completion_tokens: 7,
        prompt_tokens_details: null,
      };
      const body =
        mode === "json"
          ? JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "Hello" },
                  finish_reason: "stop",
                },
              ],
              usage,
            })
          : [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
              `data: ${JSON.stringify({ choices: [], usage })}`,
              "data: [DONE]",
              "",
            ].join("\n\n");
      await seedCapturedUpstream(
        t,
        {
          status: 200,
          contentType:
            mode === "json" ? "application/json" : "text/event-stream",
          body,
        },
        { managed: { configured: true, launched: true }, cache: false },
      );
      const response = await buildApp().request(
        protocol === "openai"
          ? "/v1/chat/completions"
          : "/anthropic/v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "captured-model",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 10,
            stream: mode === "sse",
            ...(mode === "json" ? { logprobs: true } : {}),
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
      const trace = listApiProxyTraces()[0]!;
      assert.equal(trace.usage?.cacheReadTokens, 0);
      assert.equal(trace.usage?.promptTokens, 120);
    });
  }
}

for (const scenario of [
  {
    name: "flag added without restart",
    configured: true,
    launched: false,
    expected: null,
  },
  {
    name: "flag removed without restart",
    configured: false,
    launched: true,
    expected: 0,
  },
  {
    name: "missing launch snapshot",
    configured: true,
    launched: true,
    snapshot: false,
    expected: null,
  },
  {
    name: "reported cache hit",
    configured: true,
    launched: true,
    cached: 80,
    expected: 80,
  },
  {
    name: "missing usage",
    configured: true,
    launched: true,
    noUsage: true,
    expected: undefined,
  },
  {
    name: "missing prompt count",
    configured: true,
    launched: true,
    noPrompt: true,
    expected: null,
  },
  {
    name: "embeddings",
    configured: true,
    launched: true,
    path: "/v1/embeddings",
    expected: null,
  },
  {
    name: "llama engine",
    configured: true,
    launched: true,
    kind: "llama-server" as const,
    expected: null,
  },
  {
    name: "external endpoint",
    configured: true,
    launched: true,
    external: true,
    expected: null,
  },
]) {
  test(`SGLang cache normalization respects ${scenario.name}`, async (t) => {
    await seedCapturedUpstream(
      t,
      {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Hello" },
              finish_reason: "stop",
            },
          ],
          ...(scenario.noUsage
            ? {}
            : {
                usage: {
                  ...(scenario.noPrompt ? {} : { prompt_tokens: 120 }),
                  completion_tokens: 7,
                  ...(scenario.cached === undefined
                    ? {}
                    : {
                        prompt_tokens_details: {
                          cached_tokens: scenario.cached,
                        },
                      }),
                },
              }),
        }),
      },
      { ...(scenario.external ? {} : { managed: scenario }), cache: false },
    );
    const response = await buildApp().request(
      scenario.path ?? "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "captured-model",
          messages: [{ role: "user", content: "hi" }],
          input: "hi",
          logprobs: true,
        }),
      },
    );
    assert.equal(response.status, 200, await response.text());
    const trace = listApiProxyTraces()[0]!;
    assert.equal(trace.usage?.cacheReadTokens, scenario.expected);
  });
}

for (const kind of ["sglang", "vllm"] as const) {
  for (const mode of [
    "openai",
    "anthropic",
    "buffered",
    "multi-choice",
    "continuous",
  ] as const) {
    test(`${kind} stream rate handles ${mode}`, async (t) => {
      await seedCapturedUpstream(
        t,
        {
          status: 200,
          contentType: "text/event-stream",
          body: [
            `data: ${JSON.stringify({ choices: [{ delta: { [kind === "vllm" ? "reasoning" : "reasoning_content"]: "Thinking" }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } })}`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
        },
        {
          managed: { kind, configured: true, launched: true },
          cache: false,
          chunkDelayMs: 20,
        },
      );
      const response = await postCapturedRequest(
        buildApp(),
        mode === "anthropic" ? "anthropic" : "openai",
        mode !== "buffered",
        mode === "multi-choice"
          ? { n: 2 }
          : mode === "continuous"
            ? { stream_options: { continuous_usage_stats: true } }
            : {},
      );
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const trace = listApiProxyTraces()[0]!;
      assert.ok(trace.usage);
      if (mode === "multi-choice" || mode === "continuous") {
        assert.equal(trace.usage.rateSource, undefined);
        assert.equal(trace.usage.ratePerSecond, null);
      } else {
        assert.equal(trace.usage.rateSource, "proxy");
        assert.ok(trace.usage.genMs > 0);
        assert.ok(
          trace.usage.ratePerSecond !== null && trace.usage.ratePerSecond > 0,
        );
      }
      assert.equal(trace.usage.completionTokens, 40);
      assert.equal(trace.usage.cacheReadTokens, kind === "sglang" ? 0 : null);
      assert.equal(body.includes("predicted_ms"), false);
      assert.equal(body.includes("observedGenMs"), false);
      assert.equal(body.includes("rateSource"), false);
    });
  }
}

for (const mode of [
  "openai",
  "anthropic",
  "buffered",
  "json",
  "anthropic-json",
] as const) {
  test(`vLLM native decode timing takes priority for ${mode}`, async (t) => {
    const json = mode === "json" || mode === "anthropic-json";
    const usage = { prompt_tokens: 120, completion_tokens: 40 };
    const metrics = {
      generation_time_ms: 500,
      time_to_first_token_ms: 1_000,
      queue_time_ms: 2_000,
      tokens_per_second: 26.67,
    };
    await seedCapturedUpstream(
      t,
      {
        status: 200,
        contentType: json ? "application/json" : "text/event-stream",
        body: json
          ? JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "Answer" },
                  finish_reason: "stop",
                },
              ],
              usage,
              metrics,
            })
          : [
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Thinking" }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] })}`,
              `data: ${JSON.stringify({ choices: [], usage, metrics })}`,
              "data: [DONE]",
              "",
            ].join("\n\n"),
      },
      {
        managed: { kind: "vllm", configured: false, launched: false },
        cache: false,
        ...(json ? {} : { chunkDelayMs: 20 }),
      },
    );
    const response = await postCapturedRequest(
      buildApp(),
      mode.startsWith("anthropic") ? "anthropic" : "openai",
      !json && mode !== "buffered",
      json ? { logprobs: true } : {},
    );
    assert.equal(response.status, 200, await response.text());
    const trace = listApiProxyTraces()[0]!;
    assert.equal(trace.usage?.completionTokens, 40);
    assert.equal(trace.usage?.genMs, 500);
    assert.equal(trace.usage?.ratePerSecond, 80);
    assert.equal(trace.usage?.rateSource, undefined);
  });
}
