import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiProxyInflightRequest,
  ApiProxyModelRecord,
  ApiProxyModelState,
  ApiProxyPipelineRecord,
  ApiProxyPortRef,
  ApiProxyRuntimeSnapshot,
  ApiProxyTargetRuntime,
} from "@arriero/core";

import {
  aggregateApiProxyLoadState,
  deriveApiProxyModelStatus,
  resolveApiProxyModelLeafTargetIds,
} from "./model-status.js";

function targetRuntime(
  targetId: string,
  state: ApiProxyModelState,
  availableSlots: number | null = null,
): ApiProxyTargetRuntime {
  return {
    targetId,
    kind: "managed-instance",
    endpointId: "endpoint",
    baseUrl: "http://127.0.0.1",
    instanceId: "instance",
    model: null,
    state,
    stateDetail: null,
    activeRequests: 0,
    availableSlots,
    idleSince: null,
    lastRequestAt: null,
    savedSlotIds: [],
    inflight: [],
  };
}

function snapshot(targets: ApiProxyTargetRuntime[]): ApiProxyRuntimeSnapshot {
  return { checkedAt: "2026-06-26T00:00:00.000Z", targets };
}

function model(overrides: Partial<ApiProxyModelRecord>): ApiProxyModelRecord {
  return {
    id: "model",
    modelId: "public",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
    blockedMessage: "",
    ...overrides,
  };
}

function inflight(
  phase: ApiProxyInflightRequest["phase"],
): ApiProxyInflightRequest {
  return {
    id: "request",
    originId: null,
    modelId: "public",
    sourceId: null,
    sourceName: null,
    protocol: "openai",
    stream: true,
    phase,
    waitingMs: 0,
    prefillMs: null,
    thinkingMs: null,
    generatingMs: null,
    promptTokens: null,
    completionTokens: 0,
    prefillTotalTokens: null,
    prefillProcessedTokens: null,
    prefillCachedTokens: null,
    reasoningChars: 0,
    answerChars: 0,
    toolCalls: 0,
    controls: {
      forceAnswer: { available: false, reason: "not-supported" },
      finish: { available: false, reason: "not-supported" },
      cancel: { available: false, reason: "not-supported" },
    },
  };
}

function pipeline(id: string, entry: ApiProxyPortRef): ApiProxyPipelineRecord {
  return {
    id,
    name: id,
    enabled: true,
    entry,
    nodes: [],
  };
}

test("aggregateApiProxyLoadState mirrors the llama.cpp set for one leaf and adds partial for many", () => {
  assert.equal(aggregateApiProxyLoadState([]), "unloaded");
  assert.equal(aggregateApiProxyLoadState(["loaded"]), "loaded");
  assert.equal(aggregateApiProxyLoadState(["loading"]), "loading");
  assert.equal(aggregateApiProxyLoadState(["failed"]), "failed");
  assert.equal(aggregateApiProxyLoadState(["unloaded"]), "unloaded");
  assert.equal(aggregateApiProxyLoadState(["loaded", "loaded"]), "loaded");
  assert.equal(aggregateApiProxyLoadState(["loaded", "unloaded"]), "partial");
  assert.equal(aggregateApiProxyLoadState(["loaded", "loading"]), "partial");
  assert.equal(aggregateApiProxyLoadState(["loading", "unloaded"]), "loading");
  assert.equal(aggregateApiProxyLoadState(["failed", "failed"]), "failed");
  assert.equal(aggregateApiProxyLoadState(["failed", "unloaded"]), "failed");
});

test("resolveApiProxyModelLeafTargetIds resolves targets, legacy targetId, and nested pipelines", () => {
  const pipelines = new Map([
    ["p1", pipeline("p1", { type: "pipeline", id: "p2" })],
    ["p2", pipeline("p2", { type: "target", id: "deep-target" })],
  ]);

  assert.deepEqual(
    resolveApiProxyModelLeafTargetIds(
      model({ routeTo: { type: "target", id: "t1" } }),
      pipelines,
    ),
    ["t1"],
  );
  assert.deepEqual(
    resolveApiProxyModelLeafTargetIds(
      model({ routeTo: null, targetId: "legacy" }),
      pipelines,
    ),
    ["legacy"],
  );
  assert.deepEqual(
    resolveApiProxyModelLeafTargetIds(
      model({ routeTo: { type: "pipeline", id: "p1" } }),
      pipelines,
    ),
    ["deep-target"],
  );
  assert.deepEqual(
    resolveApiProxyModelLeafTargetIds(
      model({ routeTo: null, targetId: null }),
      pipelines,
    ),
    [],
  );
});

test("deriveApiProxyModelStatus splits active vs queued and maps the target load state", () => {
  const status = deriveApiProxyModelStatus({
    model: model({ routeTo: { type: "target", id: "t1" } }),
    snapshot: snapshot([targetRuntime("t1", "ready", 1)]),
    pipelinesById: new Map(),
    inflight: [
      inflight("queued"),
      inflight("prefilling"),
      inflight("generating"),
    ],
  });

  assert.equal(status.value, "loaded");
  assert.equal(status.activeRequests, 2);
  assert.equal(status.queuedRequests, 1);
  assert.equal(status.availableSlots, 1);
});

test("deriveApiProxyModelStatus reports disabled while still counting requests", () => {
  const status = deriveApiProxyModelStatus({
    model: model({ enabled: false, routeTo: { type: "target", id: "t1" } }),
    snapshot: snapshot([targetRuntime("t1", "ready", 4)]),
    pipelinesById: new Map(),
    inflight: [inflight("queued")],
  });

  assert.equal(status.value, "disabled");
  assert.equal(status.queuedRequests, 1);
  assert.equal(status.availableSlots, 0);
});

test("deriveApiProxyModelStatus follows a pipeline route to its target leaf", () => {
  const pipelines = new Map([
    ["p1", pipeline("p1", { type: "target", id: "t1" })],
  ]);
  const status = deriveApiProxyModelStatus({
    model: model({ routeTo: { type: "pipeline", id: "p1" } }),
    snapshot: snapshot([targetRuntime("t1", "loading", 0)]),
    pipelinesById: pipelines,
    inflight: [],
  });

  assert.equal(status.value, "loading");
  assert.equal(status.availableSlots, 0);
});

test("model aliases share target availability independently of their own activity", () => {
  const runtime = snapshot([targetRuntime("shared", "ready", 1)]);
  for (const modelId of ["interactive", "background"]) {
    const status = deriveApiProxyModelStatus({
      model: model({ modelId, routeTo: { type: "target", id: "shared" } }),
      snapshot: runtime,
      pipelinesById: new Map(),
      inflight: modelId === "interactive" ? [inflight("generating")] : [],
    });
    assert.equal(status.availableSlots, 1);
    assert.equal(status.activeRequests, modelId === "interactive" ? 1 : 0);
  }
});

test("availability stays unknown for external, missing, and multi-target routes", () => {
  const branching = pipeline("branching", { type: "node", id: "condition" });
  branching.nodes = [
    {
      id: "condition",
      name: "",
      type: "condition",
      config: { predicate: { type: "source", sourceId: null } },
      ports: {
        true: { type: "target", id: "t1" },
        false: { type: "target", id: "t2" },
      },
    },
  ];
  for (const routeTo of [
    { type: "endpoint", endpointId: "external", upstreamModel: "chat" },
    { type: "target", id: "missing" },
    { type: "pipeline", id: "branching" },
  ] as const) {
    const status = deriveApiProxyModelStatus({
      model: model({ routeTo }),
      snapshot: snapshot([
        targetRuntime("t1", "ready", 2),
        targetRuntime("t2", "ready", 3),
      ]),
      pipelinesById: new Map([[branching.id, branching]]),
      inflight: [],
    });
    assert.equal(status.availableSlots, null);
  }
});
