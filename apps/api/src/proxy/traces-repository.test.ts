import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import type {
  ApiProxyRequestTrace,
  ApiProxyTraceFile,
  ApiProxyTraceListFilter,
} from "@arriero/core";

import { config } from "../config.js";
import { sqlite } from "../db/index.js";
import { saveApiProxyRequestFile } from "./request-files.js";
import {
  clearApiProxyTraceHistory,
  countApiProxyTraces,
  getApiProxyTraceFacets,
  insertApiProxyTrace,
  listApiProxyTraces,
  listApiProxyTracesSince,
  pruneApiProxyTraceHistory,
} from "./traces-repository.js";

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

const NOW = new Date("2026-07-31T12:00:00.000Z");

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  clearApiProxyTraceHistory();
});

test("lists newest-first with limit and before cursor", () => {
  insertApiProxyTrace(trace({ id: "a", at: "2026-07-31T10:00:00.000Z" }));
  insertApiProxyTrace(trace({ id: "b", at: "2026-07-31T11:00:00.000Z" }));
  insertApiProxyTrace(trace({ id: "c", at: "2026-07-31T12:00:00.000Z" }));

  const all = listApiProxyTraces();
  assert.deepEqual(
    all.map((entry) => entry.id),
    ["c", "b", "a"],
  );

  const limited = listApiProxyTraces({ limit: 2 });
  assert.deepEqual(
    limited.map((entry) => entry.id),
    ["c", "b"],
  );

  const paged = listApiProxyTraces({ before: "2026-07-31T12:00:00.000Z" });
  assert.deepEqual(
    paged.map((entry) => entry.id),
    ["b", "a"],
  );
});

test("breaks same-timestamp ties by insertion order", () => {
  const at = "2026-07-31T10:00:00.000Z";
  for (let i = 0; i < 5; i += 1) {
    insertApiProxyTrace(trace({ id: `t${i}`, at }));
  }
  assert.deepEqual(
    listApiProxyTraces().map((entry) => entry.id),
    ["t4", "t3", "t2", "t1", "t0"],
  );
});

test("filters by model, source, target and outcome", () => {
  insertApiProxyTrace(
    trace({ id: "a", at: daysBefore(1), modelId: "m1", sourceId: "s1" }),
  );
  insertApiProxyTrace(
    trace({
      id: "b",
      at: daysBefore(2),
      modelId: "m2",
      targetId: "tg1",
      ok: false,
      status: 503,
      errorCode: "model_disabled",
    }),
  );

  assert.deepEqual(
    listApiProxyTraces({ modelId: "m2" }).map((entry) => entry.id),
    ["b"],
  );
  assert.deepEqual(
    listApiProxyTraces({ sourceId: "s1" }).map((entry) => entry.id),
    ["a"],
  );
  assert.deepEqual(
    listApiProxyTraces({ targetId: "tg1" }).map((entry) => entry.id),
    ["b"],
  );
  assert.deepEqual(
    listApiProxyTraces({ ok: false }).map((entry) => entry.id),
    ["b"],
  );
  assert.deepEqual(
    listApiProxyTraces({ ok: true }).map((entry) => entry.id),
    ["a"],
  );
});

test("filters by protocol, endpoint, status, error code, cache and flags", () => {
  insertApiProxyTrace(trace({ id: "openai-chat", at: daysBefore(1) }));
  insertApiProxyTrace(
    trace({
      id: "anthropic-messages",
      at: daysBefore(2),
      protocol: "anthropic",
      endpoint: "messages",
      translated: true,
      stream: true,
      resumed: true,
      cache: "hit",
      status: 429,
      ok: false,
      errorCode: "overloaded",
      durationMs: 5000,
    }),
  );

  const ids = (filter: ApiProxyTraceListFilter) =>
    listApiProxyTraces(filter).map((entry) => entry.id);

  assert.deepEqual(ids({ protocol: "anthropic" }), ["anthropic-messages"]);
  assert.deepEqual(ids({ endpoint: "messages" }), ["anthropic-messages"]);
  assert.deepEqual(ids({ status: 429 }), ["anthropic-messages"]);
  assert.deepEqual(ids({ errorCode: "overloaded" }), ["anthropic-messages"]);
  assert.deepEqual(ids({ cache: "hit" }), ["anthropic-messages"]);
  assert.deepEqual(ids({ cache: "none" }), ["openai-chat"]);
  assert.deepEqual(ids({ stream: true }), ["anthropic-messages"]);
  assert.deepEqual(ids({ resumed: true }), ["anthropic-messages"]);
  assert.deepEqual(ids({ translated: true }), ["anthropic-messages"]);
  assert.deepEqual(ids({ minDurationMs: 1000 }), ["anthropic-messages"]);
});

test("filters by attached files and facets their kinds", () => {
  const file = (kind: string, seq: number): ApiProxyTraceFile => ({
    name: `0${seq}-${kind}.json`,
    path: `m1/dir/0${seq}-${kind}.json`,
    kind,
    label: null,
    bytes: 12,
    createdAt: NOW.toISOString(),
  });

  insertApiProxyTrace(trace({ id: "plain", at: daysBefore(1) }));
  insertApiProxyTrace(
    trace({
      id: "captured",
      at: daysBefore(2),
      files: [
        file("capture-request", 1),
        file("capture-request", 2),
        file("capture-response", 3),
      ],
    }),
  );
  insertApiProxyTrace(
    trace({
      id: "response-only",
      at: daysBefore(3),
      files: [file("capture-response", 1)],
    }),
  );

  const ids = (filter: ApiProxyTraceListFilter) =>
    listApiProxyTraces(filter).map((entry) => entry.id);

  assert.deepEqual(ids({ hasFiles: true }), ["captured", "response-only"]);
  assert.deepEqual(ids({ hasFiles: false }), ["plain"]);
  assert.deepEqual(ids({ fileKind: "capture-request" }), ["captured"]);
  assert.deepEqual(ids({ fileKind: "capture-response" }), [
    "captured",
    "response-only",
  ]);
  assert.deepEqual(ids({ fileKind: "capture" }), []);
  assert.equal(countApiProxyTraces({ fileKind: "capture-request" }), 1);

  assert.deepEqual(getApiProxyTraceFacets().fileKinds, [
    { value: "capture-response", name: null, count: 2 },
    { value: "capture-request", name: null, count: 1 },
  ]);
});

test("filters by inclusive time range", () => {
  insertApiProxyTrace(trace({ id: "a", at: daysBefore(5) }));
  insertApiProxyTrace(trace({ id: "b", at: daysBefore(3) }));
  insertApiProxyTrace(trace({ id: "c", at: daysBefore(1) }));

  assert.deepEqual(
    listApiProxyTraces({ from: daysBefore(4), to: daysBefore(2) }).map(
      (entry) => entry.id,
    ),
    ["b"],
  );
  assert.deepEqual(
    listApiProxyTraces({ from: daysBefore(3), to: daysBefore(3) }).map(
      (entry) => entry.id,
    ),
    ["b"],
  );
});

test("counts traces matching the filter", () => {
  insertApiProxyTrace(trace({ id: "a", at: daysBefore(1) }));
  insertApiProxyTrace(
    trace({ id: "b", at: daysBefore(2), ok: false, status: 500 }),
  );

  assert.equal(countApiProxyTraces(), 2);
  assert.equal(countApiProxyTraces({ ok: false }), 1);
  assert.equal(countApiProxyTraces({ modelId: "absent" }), 0);
});

test("facets aggregate distinct values with names and counts", () => {
  insertApiProxyTrace(
    trace({
      id: "a",
      at: daysBefore(1),
      modelId: "m1",
      sourceId: "s1",
      sourceName: "claude-code",
    }),
  );
  insertApiProxyTrace(
    trace({
      id: "b",
      at: daysBefore(2),
      modelId: "m1",
      targetId: "tg1",
      targetName: "local",
      protocol: "anthropic",
      endpoint: "messages",
      status: 503,
      ok: false,
      errorCode: "model_disabled",
    }),
  );

  const facets = getApiProxyTraceFacets();
  assert.equal(facets.retentionDays, 30);
  assert.deepEqual(facets.models, [{ value: "m1", name: null, count: 2 }]);
  assert.deepEqual(facets.sources, [
    { value: "s1", name: "claude-code", count: 1 },
  ]);
  assert.deepEqual(facets.targets, [{ value: "tg1", name: "local", count: 1 }]);
  assert.deepEqual(facets.errorCodes, [
    { value: "model_disabled", name: null, count: 1 },
  ]);
  assert.equal(facets.protocols.length, 2);
  assert.equal(facets.endpoints.length, 2);
  assert.equal(facets.statuses.length, 2);
});

test("listApiProxyTracesSince returns ascending traces from the cutoff", () => {
  insertApiProxyTrace(trace({ id: "old", at: daysBefore(3) }));
  insertApiProxyTrace(trace({ id: "new", at: daysBefore(1) }));

  const since = listApiProxyTracesSince(daysBefore(2));
  assert.deepEqual(
    since.map((entry) => entry.id),
    ["new"],
  );
});

test("round-trips full scheduler actions with reasons", () => {
  const actions: ApiProxyRequestTrace["schedulerActions"] = [
    {
      type: "unload-model",
      targetId: "tg-idle",
      instanceId: "idle-instance",
      model: "qwen-old",
      slotId: null,
      reason: "evicting idle target to free the pool",
    },
    {
      type: "route-request",
      targetId: "tg-hot",
      instanceId: "hot-instance",
      model: "qwen-new",
      slotId: 1,
      reason: "target is selected",
    },
  ];
  insertApiProxyTrace(
    trace({ id: "a", at: daysBefore(1), schedulerActions: actions }),
  );

  assert.deepEqual(listApiProxyTraces()[0]?.schedulerActions, actions);
});

test("normalizes legacy string scheduler actions to full action objects", () => {
  const legacy: Record<string, unknown> = {
    ...trace({ id: "legacy", at: daysBefore(1) }),
    schedulerActions: ["start-instance", "route-request"],
  };
  sqlite
    .prepare(
      `INSERT INTO proxy_request_traces
        (id, at, protocol, endpoint, model_id, status, ok, resumed, translated, duration_ms, trace_json)
       VALUES ('legacy', ?, 'openai', 'chat.completions', 'm1', 200, 1, 0, 0, 1, ?)`,
    )
    .run(daysBefore(1), JSON.stringify(legacy));

  assert.deepEqual(listApiProxyTraces()[0]?.schedulerActions, [
    {
      type: "start-instance",
      targetId: null,
      instanceId: null,
      model: null,
      slotId: null,
      reason: null,
    },
    {
      type: "route-request",
      targetId: null,
      instanceId: null,
      model: null,
      slotId: null,
      reason: null,
    },
  ]);
});

test("skips rows whose stored JSON no longer parses", () => {
  insertApiProxyTrace(trace({ id: "good", at: daysBefore(1) }));
  sqlite
    .prepare(
      `INSERT INTO proxy_request_traces
        (id, at, protocol, endpoint, model_id, status, ok, resumed, translated, duration_ms, trace_json)
       VALUES ('bad', ?, 'openai', 'chat.completions', 'm1', 200, 1, 0, 0, 1, 'not-json')`,
    )
    .run(daysBefore(1));

  assert.deepEqual(
    listApiProxyTraces().map((entry) => entry.id),
    ["good"],
  );
});

test("prune drops traces past retention together with their capture artifacts", () => {
  const oldAt = daysBefore(40);
  const freshAt = daysBefore(1);
  insertApiProxyTrace(trace({ id: "old", at: oldAt, modelId: "model-old" }));
  insertApiProxyTrace(
    trace({ id: "fresh", at: freshAt, modelId: "model-fresh" }),
  );
  const oldFile = saveApiProxyRequestFile({
    traceId: "old",
    traceAt: oldAt,
    kind: "inbound",
    label: null,
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "model-old",
    data: { probe: true },
  });
  const freshFile = saveApiProxyRequestFile({
    traceId: "fresh",
    traceAt: freshAt,
    kind: "inbound",
    label: null,
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "model-fresh",
    data: { probe: true },
  });
  const filesRoot = resolve(config.dataDir, "proxy-requests");
  assert.equal(existsSync(resolve(filesRoot, oldFile.path)), true);

  const pruned = pruneApiProxyTraceHistory(NOW);
  assert.equal(pruned.prunedTraces, 1);
  assert.equal(pruned.prunedRequestDirs, 1);
  assert.deepEqual(
    listApiProxyTraces().map((entry) => entry.id),
    ["fresh"],
  );
  assert.equal(existsSync(resolve(filesRoot, oldFile.path)), false);
  assert.equal(existsSync(resolve(filesRoot, "model-old")), false);
  assert.equal(existsSync(resolve(filesRoot, freshFile.path)), true);
});
