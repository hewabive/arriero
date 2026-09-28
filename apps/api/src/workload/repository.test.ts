import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { WorkloadRecord } from "@arriero/core";

import {
  buildWorkloadProfile,
  describeWorkloadPeriod,
  workloadLinkingGroups,
  type WorkloadLinkingRecord,
  type WorkloadProfileRange,
  type WorkloadProfileRecord,
} from "./profile.js";
import { WORKLOAD_NORMALIZATION_VERSION } from "./record-analysis.js";
import {
  clearWorkloadRecords,
  insertWorkloadRecord,
  listWorkloadLinkingRecords,
  listWorkloadProfileRecords,
  listWorkloadRecords,
  type WorkloadRecordRow,
  type WorkloadScope,
} from "./repository.js";

const BASE = Date.parse("2026-09-20T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ROWS = 180;

const durations = [0, 1, 45_000, 20 * MINUTE, 3 * HOUR];
const outcomes = ["success", "client-abort", "error", "not-served"];
const sources: Array<[string | null, string | null]> = [
  [null, null],
  ["src-a", "agents"],
  ["src-b", null],
];
const targets: Array<[string | null, string | null]> = [
  ["gpu0", "gpu0"],
  ["gpu1", "gpu1"],
  [null, null],
];

function traceId(index: number): string {
  return `r${String(index).padStart(4, "0")}`;
}

function parentOf(index: number): string | null {
  if (index % 6 === 0) {
    return null;
  }
  return index % 17 === 0 ? "gone" : traceId(index - 1);
}

function fixture(index: number): WorkloadRecordRow {
  const atMs = BASE + Math.floor(index / 2) * 3 * MINUTE;
  const durationMs = durations[index % durations.length] ?? 0;
  const [sourceId, sourceName] = sources[index % sources.length] ?? [
    null,
    null,
  ];
  const [targetId, targetName] = targets[
    Math.floor(index / 3) % targets.length
  ] ?? [null, null];
  const anthropic = index % 2 === 1;
  const endpoint =
    index % 11 === 0
      ? anthropic
        ? "messages.count_tokens"
        : "embeddings"
      : anthropic
        ? "messages"
        : "chat.completions";
  return {
    traceId: traceId(index),
    at: new Date(atMs).toISOString(),
    endAt: new Date(atMs + durationMs).toISOString(),
    durationMs,
    sourceId,
    sourceName,
    modelId: index % 4 < 2 ? "agent" : "coder",
    targetId,
    targetName,
    protocol: anthropic ? "anthropic" : "openai",
    endpoint,
    outcome: outcomes[index % outcomes.length] ?? "success",
    issue: index % 13 === 0 ? "stateful-request" : null,
    capturePath: null,
    messageCount: index % 9 === 0 ? null : 2 + (index % 7),
    chainKey: `key-${index}`,
    sessionId: `s${Math.floor(index / 6)}`,
    parentTraceId: parentOf(index),
    sharedMessages: null,
    clientSessionId:
      index % 5 === 0 ? null : `client-${Math.floor(index / 4) % 3}`,
    promptTokens: index % 8 === 0 ? null : 500 + ((index * 37) % 4000),
    cacheReadTokens: index % 5 === 0 ? null : (index * 53) % 400,
    completionTokens: index % 7 === 0 ? null : 20 + ((index * 29) % 900),
    ttftMs: 200,
    thinkTimeMs: null,
    cacheLossTokens: index % 4 === 0 ? 100 + index : null,
    responseReuseTokens: index % 6 === 1 ? 20 : null,
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
  };
}

function profileFields(record: WorkloadRecord): WorkloadProfileRecord {
  return {
    at: record.at,
    durationMs: record.durationMs,
    sessionId: record.sessionId,
    outcome: record.outcome,
    promptTokens: record.promptTokens,
    cacheReadTokens: record.cacheReadTokens,
    completionTokens: record.completionTokens,
    cacheLossTokens: record.cacheLossTokens,
    responseReuseTokens: record.responseReuseTokens,
  };
}

function linkingFields(record: WorkloadRecord): WorkloadLinkingRecord {
  return {
    traceId: record.traceId,
    sourceId: record.sourceId,
    sourceName: record.sourceName,
    modelId: record.modelId,
    sessionId: record.sessionId,
    messageCount: record.messageCount,
    parentTraceId: record.parentTraceId,
    clientSessionId: record.clientSessionId,
  };
}

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

const cases: Array<{ scope: WorkloadScope; range: WorkloadProfileRange }> = [
  {
    scope: {},
    range: {
      fromMs: BASE - HOUR,
      toMs: BASE + 8 * HOUR,
      windowMs: 30 * MINUTE,
      stepMs: 10 * MINUTE,
    },
  },
  ...[
    {},
    { sourceId: "src-a" },
    { modelId: "coder" },
    { targetId: "gpu1" },
    { sourceId: "src-b", modelId: "agent", targetId: "gpu0" },
  ].map((filters) => ({
    scope: { from: iso(HOUR), to: iso(3 * HOUR + 30 * MINUTE), ...filters },
    range: {
      fromMs: BASE + HOUR,
      toMs: BASE + 3 * HOUR + 30 * MINUTE,
      windowMs: 15 * MINUTE,
      stepMs: 5 * MINUTE,
    },
  })),
];

beforeEach(() => {
  clearWorkloadRecords();
  for (let index = 0; index < ROWS; index += 1) {
    insertWorkloadRecord(fixture(index));
  }
});

test("the profile and linking projections read what the full records read", () => {
  for (const { scope, range } of cases) {
    const full = listWorkloadRecords(scope);
    const profileRecords = listWorkloadProfileRecords(scope);
    const linkingRecords = listWorkloadLinkingRecords(scope);
    assert.ok(full.length > 0, JSON.stringify(scope));
    assert.deepEqual(profileRecords, full.map(profileFields));
    assert.deepEqual(linkingRecords, full.map(linkingFields));
    assert.deepEqual(
      buildWorkloadProfile(profileRecords, range),
      buildWorkloadProfile(full, range),
    );
    assert.deepEqual(
      describeWorkloadPeriod(profileRecords, range.fromMs, range.toMs),
      describeWorkloadPeriod(full, range.fromMs, range.toMs),
    );
    assert.deepEqual(
      workloadLinkingGroups(linkingRecords),
      workloadLinkingGroups(full),
    );
  }

  const ranged = { from: iso(HOUR), to: iso(3 * HOUR + 30 * MINUTE) };
  const inRange = new Set(
    listWorkloadRecords(ranged).map((record) => record.traceId),
  );
  assert.ok(inRange.has(traceId(14)));
  assert.ok(!inRange.has(traceId(20)));
  assert.ok(
    listWorkloadLinkingRecords(ranged).some(
      (record) =>
        record.parentTraceId !== null && !inRange.has(record.parentTraceId),
    ),
  );
  const groups = workloadLinkingGroups(listWorkloadLinkingRecords(ranged));
  assert.ok(groups.length > 1);
  assert.ok(
    groups.some(
      (group) =>
        group.clientSessionAgreeing > 0 &&
        group.clientSessionAgreeing < group.clientSessionPairs &&
        group.clientSessionPairs < group.linkedRecords,
    ),
  );
});

test("a row outside the outcome enum stays out of the profile read, as out of the full read", () => {
  clearWorkloadRecords();
  insertWorkloadRecord(fixture(1));
  insertWorkloadRecord({ ...fixture(2), outcome: "retired" });
  assert.deepEqual(
    listWorkloadRecords({}).map((record) => record.traceId),
    [traceId(1)],
  );
  assert.deepEqual(
    listWorkloadProfileRecords({}),
    listWorkloadRecords({}).map(profileFields),
  );
});
