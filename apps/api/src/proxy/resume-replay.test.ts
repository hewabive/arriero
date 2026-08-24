import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "hono";

import { ApiProxyInflightRegistry } from "./inflight.js";
import { openAiResumableCodec } from "./openai.js";
import { ApiProxyPendingResumeStore } from "./pending-resume.js";
import type { ProxyTraceRecorder } from "./protocol-trace.js";
import { createProxyTrace } from "./protocol-trace.js";
import {
  serveResumedStreamSession,
  type ApiProxyResumeClaim,
} from "./resume-replay.js";
import type { ApiProxyStreamSessionEntry } from "./stream-session.js";

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
