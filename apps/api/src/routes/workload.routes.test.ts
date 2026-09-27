import { Hono } from "hono";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type {
  WorkloadProfile,
  WorkloadRankedWindow,
  WorkloadSessionDetail,
  WorkloadSessionSummary,
} from "@arriero/core";

import { WORKLOAD_NORMALIZATION_VERSION } from "../workload/record-analysis.js";
import {
  clearWorkloadRecords,
  insertWorkloadRecord,
  type WorkloadRecordRow,
} from "../workload/repository.js";
import { registerWorkloadRoutes } from "./workload.routes.js";

const app = new Hono();
registerWorkloadRoutes(app);

const BASE = Date.parse("2026-09-20T10:00:00.000Z");
const MINUTE = 60_000;

function row(
  traceId: string,
  offsetMinutes: number,
  over: Partial<WorkloadRecordRow> = {},
): WorkloadRecordRow {
  return {
    traceId,
    at: new Date(BASE + offsetMinutes * MINUTE).toISOString(),
    endAt: new Date(BASE + (offsetMinutes + 1) * MINUTE).toISOString(),
    durationMs: MINUTE,
    sourceId: "src",
    sourceName: "agents",
    modelId: "agent",
    targetId: "a",
    targetName: "a",
    protocol: "openai",
    endpoint: "chat.completions",
    outcome: "success",
    issue: null,
    capturePath: null,
    messageCount: 2,
    chainKey: `key-${traceId}`,
    sessionId: traceId,
    parentTraceId: null,
    sharedMessages: null,
    clientSessionId: null,
    promptTokens: 1000,
    cacheReadTokens: 500,
    completionTokens: 100,
    ttftMs: 200,
    thinkTimeMs: null,
    cacheLossTokens: null,
    responseReuseTokens: null,
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
    ...over,
  };
}

async function data<T>(path: string): Promise<{ status: number; data: T }> {
  const response = await app.request(path);
  const body = (await response.json()) as { data: T };
  return { status: response.status, data: body.data };
}

beforeEach(() => {
  clearWorkloadRecords();
  insertWorkloadRecord(row("s1", 0));
  insertWorkloadRecord(
    row("s1-b", 3, { sessionId: "s1", parentTraceId: "s1" }),
  );
  insertWorkloadRecord(row("s2", 40, { outcome: "error" }));
  insertWorkloadRecord(
    row("emb", 41, { endpoint: "embeddings", issue: "unsupported-operation" }),
  );
});

test("lists sessions newest first and pages by cursor", async () => {
  const first = await data<WorkloadSessionSummary[]>(
    "/api/workload/sessions?limit=1",
  );
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.data.map((session) => session.sessionId),
    ["s2"],
  );
  const cursor = first.data[0];
  assert.ok(cursor);
  const next = await data<WorkloadSessionSummary[]>(
    `/api/workload/sessions?limit=5&beforeAt=${encodeURIComponent(cursor.startedAt)}&beforeId=${cursor.sessionId}`,
  );
  assert.deepEqual(
    next.data.map((session) => [session.sessionId, session.records]),
    [["s1", 2]],
  );
});

test("returns a session with its records, or 404", async () => {
  const found = await data<WorkloadSessionDetail>("/api/workload/sessions/s1");
  assert.equal(found.status, 200);
  assert.equal(found.data.summary.records, 2);
  assert.deepEqual(
    found.data.records.map((record) => record.traceId),
    ["s1", "s1-b"],
  );
  const missing = await app.request("/api/workload/sessions/nope");
  assert.equal(missing.status, 404);
});

test("profiles a range and rejects an invalid one", async () => {
  const from = new Date(BASE).toISOString();
  const to = new Date(BASE + 60 * MINUTE).toISOString();
  const profile = await data<WorkloadProfile>(
    `/api/workload/profile?from=${from}&to=${to}&windowMinutes=30&stepMinutes=30`,
  );
  assert.equal(profile.status, 200);
  assert.equal(profile.data.windows.length, 2);
  assert.equal(profile.data.period.requests, 3);
  assert.equal(profile.data.windows[1]?.errors, 1);

  const inverted = await app.request(
    `/api/workload/profile?from=${to}&to=${from}`,
  );
  assert.equal(inverted.status, 400);
  const tooMany = await app.request(
    `/api/workload/profile?from=2026-01-01T00:00:00.000Z&to=${to}&stepMinutes=1`,
  );
  assert.equal(tooMany.status, 400);
});

test("ranks only error-free windows", async () => {
  const from = new Date(BASE).toISOString();
  const to = new Date(BASE + 60 * MINUTE).toISOString();
  const ranked = await data<WorkloadRankedWindow[]>(
    `/api/workload/windows?from=${from}&to=${to}&windowMinutes=30&stepMinutes=30&rank=peak`,
  );
  assert.equal(ranked.status, 200);
  assert.deepEqual(
    ranked.data.map((window) => window.startAt),
    [from],
  );
});

test("reports index status and linking", async () => {
  const status = await data<{ records: number }>("/api/workload/index");
  assert.equal(status.data.records, 4);
  const linking = await data<{
    groups: Array<{ linkedRecords: number; sessions: number }>;
  }>("/api/workload/linking");
  assert.deepEqual(
    linking.data.groups.map((group) => [group.linkedRecords, group.sessions]),
    [[1, 2]],
  );
});
