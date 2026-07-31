import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import type { ApiProxyRequestTrace } from "@arriero/core";

import { config } from "../config.js";
import { sqlite } from "../db/index.js";
import { saveApiProxyRequestFile } from "./request-files.js";
import {
  clearApiProxyTraceHistory,
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

test("listApiProxyTracesSince returns ascending traces from the cutoff", () => {
  insertApiProxyTrace(trace({ id: "old", at: daysBefore(3) }));
  insertApiProxyTrace(trace({ id: "new", at: daysBefore(1) }));

  const since = listApiProxyTracesSince(daysBefore(2));
  assert.deepEqual(
    since.map((entry) => entry.id),
    ["new"],
  );
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
