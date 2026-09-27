import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkloadRecord } from "@arriero/core";

import { planWorkloadSegments, summarizeWorkloadSegment } from "./segments.js";

const BASE = Date.parse("2026-09-20T10:00:00.000Z");
const MINUTE = 60_000;

function record(
  traceId: string,
  minute: number,
  over: Partial<WorkloadRecord> = {},
): WorkloadRecord {
  return {
    traceId,
    at: new Date(BASE + minute * MINUTE).toISOString(),
    endAt: new Date(BASE + minute * MINUTE + 10_000).toISOString(),
    durationMs: 10_000,
    sourceId: "src",
    sourceName: "agents",
    modelId: "agent",
    targetId: "a",
    targetName: "a",
    protocol: "openai",
    endpoint: "chat.completions",
    outcome: "success",
    issue: null,
    capturePath: `agent/${traceId}/01-capture-request.json`,
    messageCount: 2,
    sessionId: traceId,
    parentTraceId: null,
    sharedMessages: null,
    clientSessionId: null,
    promptTokens: 1000,
    cacheReadTokens: 900,
    completionTokens: 100,
    ttftMs: 100,
    thinkTimeMs: null,
    cacheLossTokens: null,
    responseReuseTokens: null,
    ...over,
  };
}

const window = {
  from: new Date(BASE + 10 * MINUTE).toISOString(),
  to: new Date(BASE + 25 * MINUTE).toISOString(),
};

test("cuts sessions to the window and primes those that began before it", () => {
  const before = record("s1-a", 5);
  const cacheHit = record("s1-b", 11, {
    sessionId: "s1-a",
    parentTraceId: "s1-a",
    outcome: "not-served",
  });
  const inside = record("s1-c", 12, {
    sessionId: "s1-a",
    parentTraceId: "s1-b",
  });
  const fresh = record("s2", 14);
  const known = new Map(
    [before, cacheHit, inside, fresh].map((entry) => [entry.traceId, entry]),
  );
  const result = planWorkloadSegments({
    windows: [window],
    recordsByWindow: [[before, cacheHit, inside, fresh]],
    lookup: (traceId) => known.get(traceId) ?? null,
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.segments.map((segment) => [
      segment.sessionId,
      segment.records.map((entry) => entry.traceId),
      segment.priming?.traceId ?? null,
    ]),
    [
      ["s1-a", ["s1-c"], "s1-a"],
      ["s2", ["s2"], null],
    ],
  );
  const summary = summarizeWorkloadSegment(result.segments[0]!);
  assert.equal(summary.primed, true);
  assert.equal(summary.records, 1);
});

test("refuses windows with failures or requests it cannot replay", () => {
  const result = planWorkloadSegments({
    windows: [window],
    recordsByWindow: [
      [
        record("ok", 11),
        record("failed", 12, { outcome: "error" }),
        record("rewritten", 13, { issue: "capture-after-rewrite" }),
      ],
    ],
    lookup: () => null,
  });
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0] ?? "", /1 failed request/);
  assert.match(result.problems[1] ?? "", /capture-after-rewrite/);
});

test("warns when the request before the window is gone", () => {
  const result = planWorkloadSegments({
    windows: [window],
    recordsByWindow: [[record("c", 12, { parentTraceId: "pruned" })]],
    lookup: () => null,
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.segments[0]?.priming, null);
  assert.equal(result.warnings.length, 1);
});

test("never takes one session twice and needs something to replay", () => {
  const second = {
    from: new Date(BASE + 30 * MINUTE).toISOString(),
    to: new Date(BASE + 45 * MINUTE).toISOString(),
  };
  const duplicated = planWorkloadSegments({
    windows: [window, second],
    recordsByWindow: [
      [record("a", 12)],
      [record("a-late", 35, { sessionId: "a", parentTraceId: "a" })],
    ],
    lookup: () => null,
  });
  assert.match(duplicated.problems[0] ?? "", /appears in windows 1 and 2/);
  const empty = planWorkloadSegments({
    windows: [window],
    recordsByWindow: [[record("outside", 40)]],
    lookup: () => null,
  });
  assert.deepEqual(empty.problems, [
    "the selection contains no replayable request",
  ]);
});
