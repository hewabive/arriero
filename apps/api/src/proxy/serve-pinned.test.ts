import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiProxyServeRequestSchema } from "@arriero/core";

import { instanceEndpointId } from "./endpoints.js";
import { applyDelegatedServeOrigin, ephemeralTarget } from "./serve-pinned.js";

function serveRequest(overrides: Record<string, unknown> = {}) {
  return ApiProxyServeRequestSchema.parse({
    instanceId: "qwen-big",
    protocol: "openai",
    endpoint: "chat.completions",
    stream: true,
    body: { model: "qwen", messages: [] },
    ...overrides,
  });
}

test("ephemeralTarget points at the local instance endpoint", () => {
  const target = ephemeralTarget(serveRequest());
  assert.equal(target.endpointId, instanceEndpointId("qwen-big"));
  assert.equal(target.id, "serve:qwen-big");
  assert.equal(target.name, "qwen-big");
});

test("ephemeralTarget carries the delegated QoS verbatim", () => {
  const target = ephemeralTarget(
    serveRequest({
      priority: 900,
      preemptible: false,
      model: "qwen2.5",
      role: "background",
      saveSlotsBeforeUnload: true,
      slotIds: [0, 1],
    }),
  );
  assert.equal(target.priority, 900);
  assert.equal(target.preemptible, false);
  assert.equal(target.model, "qwen2.5");
  assert.equal(target.role, "background");
  assert.equal(target.saveSlotsBeforeUnload, true);
  assert.deepEqual(target.slotIds, [0, 1]);
  assert.equal(target.idleUnloadMs, null);
});

test("ephemeralTarget defaults QoS to interactive preemptible", () => {
  const target = ephemeralTarget(serveRequest());
  assert.equal(target.priority, 100);
  assert.equal(target.preemptible, true);
  assert.equal(target.role, "interactive");
  assert.equal(target.model, null);
});

function originRecorder() {
  const calls: string[] = [];
  const trace = {
    sourceId: null as string | null,
    sourceName: null as string | null,
  };
  const inflight = {
    setOrigin(originId: string) {
      calls.push(`origin:${originId}`);
    },
    setSource(sourceId: string, sourceName: string) {
      calls.push(`source:${sourceId}:${sourceName}`);
    },
  };
  return { calls, trace, inflight };
}

test("applyDelegatedServeOrigin stamps the entry inflight id and source", () => {
  const { calls, trace, inflight } = originRecorder();
  const payload = serveRequest({
    origin: {
      inflightId: "entry-1",
      sourceId: "src-1",
      sourceName: "Claude Code",
    },
  });
  applyDelegatedServeOrigin(payload.origin, trace, inflight);
  assert.deepEqual(calls, ["origin:entry-1", "source:src-1:Claude Code"]);
  assert.equal(trace.sourceId, "src-1");
  assert.equal(trace.sourceName, "Claude Code");
});

test("applyDelegatedServeOrigin keeps anonymous delegations anonymous", () => {
  const { calls, trace, inflight } = originRecorder();
  const payload = serveRequest({ origin: { inflightId: "entry-1" } });
  applyDelegatedServeOrigin(payload.origin, trace, inflight);
  assert.deepEqual(calls, ["origin:entry-1"]);
  assert.equal(trace.sourceId, null);
});

test("applyDelegatedServeOrigin is a no-op for pre-origin peers", () => {
  const { calls, trace, inflight } = originRecorder();
  applyDelegatedServeOrigin(serveRequest().origin, trace, inflight);
  assert.deepEqual(calls, []);
  assert.equal(trace.sourceId, null);
});
