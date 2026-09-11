import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "hono";

import { ApiProxyInflightRegistry } from "./inflight.js";
import { openAiProtocolAdapter, openAiResumableCodec } from "./openai.js";
import { ApiProxyPendingResumeStore } from "./pending-resume.js";
import { runWithProxyTrace } from "./protocol-endpoint.js";
import type { ProxyTraceRecorder } from "./protocol-trace.js";
import { createProxyTrace } from "./protocol-trace.js";
import { captureApiProxyResponseSse } from "./response-capture.js";
import { readApiProxyRequestFile } from "./request-files.js";
import { createApiProxyResponsePlanExecutor } from "./response-plan.js";
import {
  serveResumedStreamSession,
  type ApiProxyResumeClaim,
} from "./resume-replay.js";
import type { ApiProxyStreamSessionEntry } from "./stream-session.js";
import { getApiProxyTrace } from "./traces-repository.js";

const operation = {
  protocol: "openai" as const,
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json" as const,
};

function session(): ApiProxyStreamSessionEntry {
  return {
    inflightId: "req-1",
    convId: "conv-1",
    instanceId: "instance-a",
    targetId: "target-a",
    modelId: "model-a",
    baseUrl: "http://127.0.0.1:8080",
    authHeaders: {},
    resumeKey: "key-1",
    protocol: "openai",
    endpoint: "chat.completions",
    stream: true,
    startedAt: "2026-07-02T00:00:00.000Z",
  };
}

const replaySse = [
  `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}`,
  "",
  `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}`,
  "",
  `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readyStore(lookupConvIds: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "resume-replay-"));
  const calls: { url: string; method: string | undefined }[] = [];
  const seed = new ApiProxyPendingResumeStore({
    file: join(dir, "pending.json"),
  });
  seed.persist([session()]);
  const store = new ApiProxyPendingResumeStore({
    file: join(dir, "pending.json"),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return new Response(
        JSON.stringify(lookupConvIds.map((id) => ({ conversation_id: id }))),
        { status: 200 },
      );
    },
  });
  await store.adopt().verified;
  return {
    store,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeContext(): Context {
  return {
    req: { raw: new Request("http://localhost/v1/chat/completions") },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}

function fakeRecorder() {
  const recorded: (Pick<Response, "status"> | undefined)[] = [];
  const recorder: ProxyTraceRecorder = {
    record: (response) => recorded.push(response),
    markDeferred: () => undefined,
    freezeDuration: () => undefined,
    beforeRecord: () => undefined,
  };
  return { recorder, recorded };
}

function claimFor(
  store: ApiProxyPendingResumeStore,
): ApiProxyResumeClaim | null {
  const entry = store.claim("key-1");
  if (!entry) {
    return null;
  }
  return {
    entry,
    baseUrl: entry.baseUrl,
    authHeaders: entry.authHeaders,
    translateAnthropic: false,
    exchangeBody: { model: "m", messages: [] },
    codec: openAiResumableCodec,
    streamIdleTimeoutMs: null,
  };
}

for (const translated of [false, true]) {
  for (const cancelAfterTerminal of [false, true]) {
    test(`stream replay persists its capture before recording, translated=${translated}, cancelAfterTerminal=${cancelAfterTerminal}`, async () => {
      const { store, cleanup } = await readyStore(["conv-1"]);
      try {
        const claim = claimFor(store);
        assert.ok(claim);
        claim.translateAnthropic = translated;
        const responseOperation = translated
          ? {
              ...operation,
              protocol: "anthropic" as const,
              endpoint: "messages",
            }
          : operation;
        let traceId = "";
        const response = await runWithProxyTrace(
          responseOperation,
          async ({ trace, recorder, inflight }) => {
            traceId = trace.id;
            trace.modelId = "model-a";
            const plan = createApiProxyResponsePlanExecutor({
              effects: [{ type: "capture-response", nodeName: null }],
              putCache: () => {},
              trace,
              operation: responseOperation,
            });
            assert.ok(plan);
            recorder.beforeRecord(() => plan.flush());
            const replayed = await serveResumedStreamSession({
              c: fakeContext(),
              adapter: { resumable: openAiResumableCodec } as never,
              request: { modelId: "model-a", stream: true, body: {} } as never,
              claim,
              trace,
              recorder,
              inflight,
              responsePlan: plan,
              store,
              fetchImpl: async () =>
                cancelAfterTerminal
                  ? new Response(
                      new ReadableStream<Uint8Array>({
                        start(controller) {
                          controller.enqueue(
                            new TextEncoder().encode(replaySse),
                          );
                        },
                      }),
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  : sseResponse(replaySse),
            });
            assert.ok(replayed);
            return replayed;
          },
        );
        let delivered = "";
        if (cancelAfterTerminal) {
          assert.ok(response.body);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const terminal = translated ? "message_stop" : "[DONE]";
          while (!delivered.includes(terminal)) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            delivered += decoder.decode(chunk.value, { stream: true });
          }
          await reader.cancel();
        } else {
          delivered = await response.text();
        }
        assert.match(delivered, translated ? /message_stop/ : /\[DONE\]/);
        const trace = getApiProxyTrace(traceId);
        assert.ok(trace);
        assert.equal(trace.usage?.completionTokens, 2);
        assert.equal(trace.streamHealth?.terminal, "done");
        assert.equal(trace.streamHealth?.truncated, false);
        assert.equal(trace.files.length, 1);
        assert.deepEqual(
          readApiProxyRequestFile(trace.files[0]!.path)?.data,
          captureApiProxyResponseSse(delivered, responseOperation),
        );
        assert.equal(store.size(), 0);
      } finally {
        cleanup();
      }
    });
  }
}

test("non-stream replay rebuilds the buffered response and evicts", async () => {
  const { store, calls, cleanup } = await readyStore(["conv-1"]);
  try {
    const claim = claimFor(store);
    assert.notEqual(claim, null);
    const trace = createProxyTrace(operation);
    const { recorder } = fakeRecorder();
    const inflight = new ApiProxyInflightRegistry().begin({
      modelId: "model-a",
      protocol: "openai",
    });

    const response = await serveResumedStreamSession({
      c: fakeContext(),
      adapter: { resumable: openAiResumableCodec } as never,
      request: { modelId: "model-a", stream: false, body: {} } as never,
      claim: claim!,
      trace,
      recorder,
      inflight,
      responsePlan: null,
      store,
      fetchImpl: async (url) => {
        assert.match(url, /\/v1\/stream\?conv_id=conv-1&from=0$/);
        return sseResponse(replaySse);
      },
    });

    assert.notEqual(response, null);
    assert.equal(response!.status, 200);
    const body = (await response!.json()) as {
      choices: { message: { content: string } }[];
    };
    assert.equal(body.choices[0]!.message.content, "Hello");
    assert.equal(trace.resumed, true);
    assert.equal(trace.usage?.completionTokens, 2);
    assert.equal(store.size(), 0);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  } finally {
    cleanup();
  }
});

test("a failed buffered replay retains observed token and cache usage", async () => {
  const { store, cleanup } = await readyStore(["conv-1"]);
  try {
    const claim = claimFor(store);
    assert.ok(claim);
    const trace = createProxyTrace(operation);
    const { recorder } = fakeRecorder();
    const inflight = new ApiProxyInflightRegistry().begin({
      modelId: "model-a",
      protocol: "openai",
    });
    const body =
      'data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":80}}}\n\n';
    const response = await serveResumedStreamSession({
      c: fakeContext(),
      adapter: openAiProtocolAdapter,
      request: { modelId: "model-a", stream: false, body: {} } as never,
      claim,
      trace,
      recorder,
      inflight,
      responsePlan: null,
      store,
      fetchImpl: async () => sseResponse(body),
    });
    assert.ok(response);
    assert.equal(response.status, 502);
    assert.equal(trace.usage?.promptTokens, 120);
    assert.equal(trace.usage?.completionTokens, 7);
    assert.equal(trace.usage?.cacheReadTokens, 80);
    assert.equal(trace.streamHealth?.truncated, true);
  } finally {
    cleanup();
  }
});

test("stream replay pipes frames, strips usage, records at completion", async () => {
  const { store, calls, cleanup } = await readyStore(["conv-1"]);
  try {
    const claim = claimFor(store);
    const trace = createProxyTrace(operation);
    const { recorder, recorded } = fakeRecorder();
    const inflight = new ApiProxyInflightRegistry().begin({
      modelId: "model-a",
      protocol: "openai",
    });

    const response = await serveResumedStreamSession({
      c: fakeContext(),
      adapter: { resumable: openAiResumableCodec } as never,
      request: { modelId: "model-a", stream: true, body: {} } as never,
      claim: claim!,
      trace,
      recorder,
      inflight,
      responsePlan: null,
      store,
      fetchImpl: async () => sseResponse(replaySse),
    });

    assert.notEqual(response, null);
    const text = await response!.text();
    assert.match(text, /Hel/);
    assert.match(text, /\[DONE\]/);
    assert.doesNotMatch(text, /"prompt_tokens":5/);
    assert.equal(trace.resumed, true);
    assert.equal(trace.usage?.completionTokens, 2);
    assert.equal(recorded.length, 1);
    assert.equal(store.size(), 0);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  } finally {
    cleanup();
  }
});

test("expired replay falls through without evicting on 404", async () => {
  const { store, calls, cleanup } = await readyStore(["conv-1"]);
  try {
    const claim = claimFor(store);
    const trace = createProxyTrace(operation);
    const { recorder } = fakeRecorder();
    const inflight = new ApiProxyInflightRegistry().begin({
      modelId: "model-a",
      protocol: "openai",
    });

    const response = await serveResumedStreamSession({
      c: fakeContext(),
      adapter: { resumable: openAiResumableCodec } as never,
      request: { modelId: "model-a", stream: true, body: {} } as never,
      claim: claim!,
      trace,
      recorder,
      inflight,
      responsePlan: null,
      store,
      fetchImpl: async () => new Response("gone", { status: 404 }),
    });

    assert.equal(response, null);
    assert.equal(trace.resumed, false);
    assert.equal(store.size(), 0);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  } finally {
    cleanup();
  }
});

test("offset-lost replay falls through and evicts the dead session", async () => {
  const { store, calls, cleanup } = await readyStore(["conv-1"]);
  try {
    const claim = claimFor(store);
    const trace = createProxyTrace(operation);
    const { recorder } = fakeRecorder();
    const inflight = new ApiProxyInflightRegistry().begin({
      modelId: "model-a",
      protocol: "openai",
    });

    const response = await serveResumedStreamSession({
      c: fakeContext(),
      adapter: { resumable: openAiResumableCodec } as never,
      request: { modelId: "model-a", stream: true, body: {} } as never,
      claim: claim!,
      trace,
      recorder,
      inflight,
      responsePlan: null,
      store,
      fetchImpl: async () => new Response("offset lost", { status: 400 }),
    });

    assert.equal(response, null);
    assert.equal(store.size(), 0);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  } finally {
    cleanup();
  }
});
