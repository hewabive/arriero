import { Hono } from "hono";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  WorkloadTimestampSchema,
  rankWorkloadWindows,
  type WorkloadLinkingReport,
  type WorkloadProfile,
  type WorkloadSessionDetail,
  type WorkloadSessionSummary,
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
const HOUR = 60 * MINUTE;

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

test("the detail of a session is the row the list shows for it", async () => {
  insertWorkloadRecord(
    row("s1-count", 2, {
      sessionId: "s1",
      protocol: "anthropic",
      endpoint: "messages.count_tokens",
      issue: "unsupported-operation",
      outcome: "error",
      promptTokens: 50_000,
      targetName: "counter",
    }),
  );
  insertWorkloadRecord(
    row("s1-c", 5, { sessionId: "s1", targetName: "gpu0, fast" }),
  );
  insertWorkloadRecord(row("s1-d", 6, { sessionId: "s1", targetName: null }));
  insertWorkloadRecord(
    row("count-only", 50, {
      protocol: "anthropic",
      endpoint: "messages.count_tokens",
      issue: "unsupported-operation",
    }),
  );

  const listed = await data<WorkloadSessionSummary[]>("/api/workload/sessions");
  const summary = listed.data.find((session) => session.sessionId === "s1");
  assert.equal(summary?.records, 4);
  assert.equal(summary?.errors, 0);
  assert.equal(summary?.maxPromptTokens, 1000);
  assert.deepEqual(summary?.targetNames, ["a", "gpu0, fast"]);
  const detail = await data<WorkloadSessionDetail>("/api/workload/sessions/s1");
  assert.deepEqual(detail.data.summary, summary);
  assert.deepEqual(
    detail.data.records.map((record) => record.traceId),
    ["s1", "s1-b", "s1-c", "s1-d"],
  );

  assert.equal(
    listed.data.some((session) => session.sessionId === "count-only"),
    false,
  );
  assert.equal(
    (await app.request("/api/workload/sessions/count-only")).status,
    404,
  );
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

test("ranks only error-free windows of a profile", async () => {
  const from = new Date(BASE).toISOString();
  const to = new Date(BASE + 60 * MINUTE).toISOString();
  const profile = await data<WorkloadProfile>(
    `/api/workload/profile?from=${from}&to=${to}&windowMinutes=30&stepMinutes=30`,
  );
  assert.deepEqual(
    rankWorkloadWindows(profile.data.windows, "peak", 10).map(
      (window) => window.startAt,
    ),
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

async function listedSessions(query: Record<string, string>) {
  const listed = await data<WorkloadSessionSummary[]>(
    `/api/workload/sessions?${new URLSearchParams(query)}`,
  );
  assert.equal(listed.status, 200);
  return listed.data.map((session) => session.sessionId);
}

test("reads range bounds as instants, whatever their notation", async () => {
  insertWorkloadRecord(row("late", 14 * 60));
  assert.deepEqual(
    await listedSessions({ from: "2026-09-20T13:30:00+03:00" }),
    ["late", "s2"],
  );
  assert.deepEqual(await listedSessions({ to: "2026-09-20T13:30:00+03:00" }), [
    "s1",
  ]);
  assert.deepEqual(
    await listedSessions({ from: "Sun, 20 Sep 2026 13:30:00 +0300" }),
    ["late", "s2"],
  );
  assert.deepEqual(await listedSessions({ from: "2026-09-21" }), ["late"]);
  assert.deepEqual(await listedSessions({ to: "2026-09-21" }), [
    "late",
    "s2",
    "s1",
  ]);
  assert.deepEqual(
    await listedSessions({
      beforeAt: "2026-09-20T13:40:00+03:00",
      beforeId: "s2",
    }),
    ["s1"],
  );

  const localMidnight = new Date(2026, 8, 21).getTime();
  assert.equal(
    WorkloadTimestampSchema.parse("2026-09-21T00:00"),
    new Date(localMidnight).toISOString(),
  );
  const startedAt: Array<[string, number]> = [
    ["late", BASE + 14 * HOUR],
    ["s2", BASE + 40 * MINUTE],
    ["s1", BASE],
  ];
  assert.deepEqual(
    await listedSessions({ to: "2026-09-21T00:00" }),
    startedAt.filter(([, at]) => at <= localMidnight).map(([id]) => id),
  );

  for (const bound of [
    "+010000-01-01T00:00:00.000Z",
    "-000001-01-01T00:00:00.000Z",
    "yesterday",
  ]) {
    const response = await app.request(
      `/api/workload/sessions?${new URLSearchParams({ from: bound })}`,
    );
    assert.equal(response.status, 400, bound);
  }
});

test("linking and selection read offset bounds as instants", async () => {
  const linking = await data<WorkloadLinkingReport>(
    `/api/workload/linking?${new URLSearchParams({ from: "2026-09-20T13:30:00+03:00" })}`,
  );
  assert.equal(linking.data.from, new Date(BASE + 30 * MINUTE).toISOString());
  assert.deepEqual(
    linking.data.groups.map((group) => [group.linkableRecords, group.sessions]),
    [[1, 1]],
  );

  const preview = await post("/api/workload/selection", {
    windows: [
      { from: "2026-09-20T13:00:00+03:00", to: "2026-09-20T13:10:00+03:00" },
    ],
  });
  assert.equal(preview.status, 200);
  const body = (await preview.json()) as {
    data: { records: number; problems: string[] };
  };
  assert.equal(body.data.records, 2);
  assert.deepEqual(body.data.problems, []);
});

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

test("previews a selection and refuses to freeze a failing window", async () => {
  const selection = {
    windows: [
      {
        from: new Date(BASE).toISOString(),
        to: new Date(BASE + 10 * MINUTE).toISOString(),
      },
    ],
  };
  const preview = await post("/api/workload/selection", selection);
  assert.equal(preview.status, 200);
  const body = (await preview.json()) as {
    data: { records: number; problems: string[] };
  };
  assert.equal(body.data.records, 2);
  assert.deepEqual(body.data.problems, []);

  const invalid = await post("/api/workload/selection", { windows: [] });
  assert.equal(invalid.status, 400);

  const failing = await post("/api/workload/datasets", {
    name: "Broken",
    selection: {
      windows: [
        {
          from: new Date(BASE + 35 * MINUTE).toISOString(),
          to: new Date(BASE + 45 * MINUTE).toISOString(),
        },
      ],
    },
  });
  assert.equal(failing.status, 400);
});

test("dataset routes answer 404 for unknown ids and 400 for bad imports", async () => {
  const unknown = "0".repeat(64);
  assert.equal(
    (await app.request(`/api/workload/datasets/${unknown}`)).status,
    404,
  );
  assert.equal(
    (await app.request(`/api/workload/datasets/${unknown}/export`)).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/api/workload/datasets/${unknown}`, {
        method: "DELETE",
      })
    ).status,
    404,
  );
  const listed = await data<unknown[]>("/api/workload/datasets");
  assert.deepEqual(listed.data, []);
  const garbage = await app.request("/api/workload/datasets/import", {
    method: "POST",
    body: "not a dataset",
    headers: { "content-type": "application/gzip" },
  });
  assert.equal(garbage.status, 400);
  const freeze = await data<null>("/api/workload/datasets/freeze");
  assert.equal(freeze.data, null);
});
