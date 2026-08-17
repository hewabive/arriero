import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { ApiProxyRequestTrace } from "@arriero/core";

import { getApiProxyActivity } from "./activity.js";
import { ApiProxyInflightRegistry } from "./inflight.js";
import {
  clearApiProxyTraceHistory,
  insertApiProxyTrace,
} from "./traces-repository.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function trace(
  over: Partial<ApiProxyRequestTrace> & { id: string; at: string },
): ApiProxyRequestTrace {
  return {
    protocol: "openai",
    translated: false,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "m1",
    sourceId: null,
    sourceName: null,
    stream: null,
    targetId: null,
    targetName: null,
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
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    durationMs: 5,
    queueMs: null,
    ttftMs: null,
    ...over,
  };
}

function activity(inflight = new ApiProxyInflightRegistry()) {
  return getApiProxyActivity({ now: NOW, inflight });
}

beforeEach(() => {
  clearApiProxyTraceHistory();
});

test("aggregates the rolling hour per model and source", () => {
  insertApiProxyTrace(
    trace({
      id: "a",
      at: minutesBefore(10),
      sourceId: "s1",
      sourceName: "claude-code",
    }),
  );
  insertApiProxyTrace(
    trace({
      id: "b",
      at: minutesBefore(5),
      sourceId: "s1",
      sourceName: "claude-code",
      ok: false,
      status: 500,
    }),
  );
  insertApiProxyTrace(trace({ id: "c", at: minutesBefore(30) }));
  insertApiProxyTrace(trace({ id: "old", at: minutesBefore(90) }));
  insertApiProxyTrace(
    trace({ id: "blank", at: minutesBefore(1), modelId: "" }),
  );

  const snapshot = activity();
  assert.equal(snapshot.windowMinutes, 60);
  assert.equal(snapshot.models.length, 1);
  const model = snapshot.models[0];
  assert.ok(model);
  assert.equal(model.modelId, "m1");
  assert.equal(model.requests, 3);
  assert.equal(model.errors, 1);
  assert.deepEqual(
    model.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      requests: source.requests,
      errors: source.errors,
    })),
    [
      { sourceId: "s1", sourceName: "claude-code", requests: 2, errors: 1 },
      { sourceId: null, sourceName: null, requests: 1, errors: 0 },
    ],
  );
});

test("orders models by request count then id", () => {
  insertApiProxyTrace(trace({ id: "a", at: minutesBefore(1), modelId: "zed" }));
  insertApiProxyTrace(
    trace({ id: "b", at: minutesBefore(2), modelId: "busy" }),
  );
  insertApiProxyTrace(
    trace({ id: "c", at: minutesBefore(3), modelId: "busy" }),
  );
  insertApiProxyTrace(
    trace({ id: "d", at: minutesBefore(4), modelId: "alto" }),
  );

  assert.deepEqual(
    activity().models.map((model) => model.modelId),
    ["busy", "alto", "zed"],
  );
});

test("merges in-flight requests with source attribution", () => {
  insertApiProxyTrace(
    trace({
      id: "done",
      at: minutesBefore(3),
      sourceId: "s1",
      sourceName: "claude-code",
    }),
  );
  const inflight = new ApiProxyInflightRegistry();
  const generating = inflight.begin({ modelId: "m1", protocol: "openai" });
  generating.setSource("s1", "claude-code");
  generating.dispatched();
  generating.firstToken();
  const queued = inflight.begin({ modelId: "m1", protocol: "openai" });
  queued.setSource("s2", "lab");
  const fresh = inflight.begin({ modelId: "m2", protocol: "openai" });
  fresh.dispatched();
  const ended = inflight.begin({ modelId: "m1", protocol: "openai" });
  ended.end(true);
  const unresolved = inflight.begin({ modelId: "", protocol: "openai" });
  unresolved.dispatched();

  const snapshot = activity(inflight);
  assert.deepEqual(
    snapshot.models.map((model) => ({
      modelId: model.modelId,
      requests: model.requests,
      activeRequests: model.activeRequests,
      queuedRequests: model.queuedRequests,
    })),
    [
      { modelId: "m1", requests: 1, activeRequests: 1, queuedRequests: 1 },
      { modelId: "m2", requests: 0, activeRequests: 1, queuedRequests: 0 },
    ],
  );
  const m1 = snapshot.models[0];
  assert.ok(m1);
  assert.deepEqual(
    m1.sources.map((source) => ({
      sourceId: source.sourceId,
      requests: source.requests,
      activeRequests: source.activeRequests,
    })),
    [
      { sourceId: "s1", requests: 1, activeRequests: 1 },
      { sourceId: "s2", requests: 0, activeRequests: 0 },
    ],
  );
  const m2 = snapshot.models[1];
  assert.ok(m2);
  assert.deepEqual(
    m2.sources.map((source) => ({
      sourceId: source.sourceId,
      activeRequests: source.activeRequests,
    })),
    [{ sourceId: null, activeRequests: 1 }],
  );
});
