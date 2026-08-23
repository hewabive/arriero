import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiProxyRequestTraceSchema,
  type ApiProxyRequestTrace,
  type FleetNode,
} from "@arriero/core";

import {
  fetchDelegatedTrace,
  mergeDelegatedTrace,
  withDelegatedTraceHeader,
  delegatedTraceHeader,
} from "./delegated-trace.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";

const node: FleetNode = {
  id: "ny",
  name: "NY",
  baseUrl: "http://ny.local:8787",
  enabled: true,
};

function entryTrace(
  over: Partial<ProxyTraceAccumulator> = {},
): ProxyTraceAccumulator {
  return {
    id: "entry-trace",
    at: "2026-08-23T10:00:00.000Z",
    protocol: "anthropic",
    translated: false,
    endpoint: "messages",
    routePath: "/anthropic/messages",
    modelId: "qwen",
    sourceId: null,
    sourceName: null,
    stream: true,
    targetId: "t1",
    targetName: "Target",
    slotId: null,
    cacheOrigin: null,
    cache: null,
    resumed: false,
    textReplacementCount: 0,
    routeTrace: [],
    files: [],
    schedulerActions: [],
    displacedTargetIds: [],
    usage: null,
    streamHealth: null,
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    translationWarnings: [],
    durationMs: 100,
    queueMs: null,
    ttftMs: null,
    ...over,
  };
}

function remoteTrace(over: Record<string, unknown> = {}): ApiProxyRequestTrace {
  return ApiProxyRequestTraceSchema.parse({
    id: "remote-trace",
    at: "2026-08-23T10:00:00.100Z",
    protocol: "anthropic",
    endpoint: "messages",
    routePath: "/anthropic/messages",
    modelId: "qwen",
    ...over,
  });
}

test("mergeDelegatedTrace fills owning-node-only fields", () => {
  const trace = entryTrace();
  mergeDelegatedTrace(
    trace,
    remoteTrace({
      translated: true,
      slotId: 2,
      cacheOrigin: "restored",
      queueMs: 340,
      ttftMs: 90,
      schedulerActions: [
        {
          type: "start-instance",
          targetId: "serve:qwen",
          instanceId: "qwen",
          model: null,
          slotId: null,
          reason: "autostart",
        },
      ],
      displacedTargetIds: ["other"],
      translationWarnings: ["dropped field"],
      errorCode: null,
    }),
  );
  assert.equal(trace.translated, true);
  assert.equal(trace.slotId, 2);
  assert.equal(trace.cacheOrigin, "restored");
  assert.equal(trace.queueMs, 340);
  assert.equal(trace.ttftMs, 90);
  assert.deepEqual(trace.schedulerActions, [
    {
      type: "start-instance",
      targetId: "serve:qwen",
      instanceId: "qwen",
      model: null,
      slotId: null,
      reason: "autostart",
    },
  ]);
  assert.deepEqual(trace.displacedTargetIds, ["other"]);
  assert.deepEqual(trace.translationWarnings, ["dropped field"]);
});

test("mergeDelegatedTrace keeps entry-side values where already measured", () => {
  const trace = entryTrace({ ttftMs: 250, errorCode: "client-abort" });
  mergeDelegatedTrace(
    trace,
    remoteTrace({ ttftMs: 90, errorCode: "arriero_proxy_upstream_error" }),
  );
  assert.equal(trace.ttftMs, 250);
  assert.equal(trace.errorCode, "client-abort");
});

test("mergeDelegatedTrace copies remote usage when the entry has none", () => {
  const trace = entryTrace();
  mergeDelegatedTrace(
    trace,
    remoteTrace({
      usage: {
        promptTokens: 4000,
        cacheReadTokens: 3000,
        cacheCreationTokens: null,
        completionTokens: 120,
        genMs: 6000,
        ratePerSecond: 20,
        prefillMs: 800,
        promptPerSecond: 5000,
      },
    }),
  );
  assert.equal(trace.usage?.promptTokens, 4000);
  assert.equal(trace.usage?.prefillMs, 800);
  assert.equal(trace.usage?.promptPerSecond, 5000);
});

test("mergeDelegatedTrace prefers server-measured usage over wall-clock", () => {
  const trace = entryTrace({
    usage: {
      promptTokens: 4000,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      completionTokens: 118,
      genMs: 7500,
      ratePerSecond: 15.7,
      prefillMs: null,
      promptPerSecond: null,
    },
  });
  mergeDelegatedTrace(
    trace,
    remoteTrace({
      usage: {
        promptTokens: null,
        cacheReadTokens: 3000,
        cacheCreationTokens: null,
        completionTokens: 120,
        genMs: 6000,
        ratePerSecond: 20,
        prefillMs: 800,
        promptPerSecond: 5000,
      },
    }),
  );
  assert.equal(trace.usage?.promptTokens, 4000);
  assert.equal(trace.usage?.cacheReadTokens, 3000);
  assert.equal(trace.usage?.completionTokens, 120);
  assert.equal(trace.usage?.genMs, 6000);
  assert.equal(trace.usage?.ratePerSecond, 20);
  assert.equal(trace.usage?.prefillMs, 800);
  assert.equal(trace.usage?.promptPerSecond, 5000);
});

test("mergeDelegatedTrace ignores an empty remote usage payload", () => {
  const trace = entryTrace({
    usage: {
      promptTokens: 10,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      completionTokens: 5,
      genMs: 100,
      ratePerSecond: 50,
      prefillMs: null,
      promptPerSecond: null,
    },
  });
  mergeDelegatedTrace(
    trace,
    remoteTrace({
      usage: {
        promptTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        completionTokens: 0,
        genMs: 0,
        ratePerSecond: null,
        prefillMs: null,
        promptPerSecond: null,
      },
    }),
  );
  assert.equal(trace.usage?.promptTokens, 10);
  assert.equal(trace.usage?.completionTokens, 5);
  assert.equal(trace.usage?.genMs, 100);
  assert.equal(trace.usage?.ratePerSecond, 50);
});

test("fetchDelegatedTrace retries until the owning node records the trace", async () => {
  let calls = 0;
  const found = remoteTrace();
  const result = await fetchDelegatedTrace(node, "remote-trace", {
    delays: [1, 1, 1],
    fetchOnce: () => {
      calls += 1;
      return Promise.resolve(calls < 3 ? null : found);
    },
  });
  assert.equal(result?.id, "remote-trace");
  assert.equal(calls, 3);
});

test("fetchDelegatedTrace gives up after the retry schedule", async () => {
  let calls = 0;
  const result = await fetchDelegatedTrace(node, "remote-trace", {
    delays: [1],
    fetchOnce: () => {
      calls += 1;
      return Promise.resolve(null);
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 2);
});

test("withDelegatedTraceHeader stamps the trace id and keeps the body", async () => {
  const response = withDelegatedTraceHeader(
    new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json", "x-keep": "1" },
    }),
    "trace-1",
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get(delegatedTraceHeader), "trace-1");
  assert.equal(response.headers.get("x-keep"), "1");
  assert.deepEqual(await response.json(), { ok: true });
});
