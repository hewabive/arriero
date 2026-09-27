import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkloadProfileWindow, WorkloadRecord } from "@arriero/core";

import {
  buildWorkloadProfile,
  rankWorkloadWindows,
  summarizeWorkloadSession,
  workloadLinkingGroups,
  workloadProfileWindowCount,
} from "./profile.js";

const BASE = Date.parse("2026-09-20T10:00:00.000Z");
const MINUTE = 60_000;

function record(
  over: Partial<WorkloadRecord> & { traceId: string; offsetMs: number },
): WorkloadRecord {
  const { offsetMs, ...rest } = over;
  const durationMs = rest.durationMs ?? 60_000;
  return {
    at: new Date(BASE + offsetMs).toISOString(),
    endAt: new Date(BASE + offsetMs + durationMs).toISOString(),
    durationMs,
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
    sessionId: over.traceId,
    parentTraceId: null,
    sharedMessages: null,
    clientSessionId: null,
    promptTokens: 1000,
    cacheReadTokens: 800,
    completionTokens: 100,
    ttftMs: 200,
    thinkTimeMs: null,
    cacheLossTokens: null,
    responseReuseTokens: null,
    ...rest,
  };
}

test("describes windows by load, prefill and cache", () => {
  const records = [
    record({ traceId: "a", offsetMs: 0 }),
    record({ traceId: "b", offsetMs: 2 * MINUTE, sessionId: "a" }),
    record({
      traceId: "c",
      offsetMs: 12 * MINUTE,
      promptTokens: 3000,
      cacheReadTokens: null,
      cacheLossTokens: 500,
    }),
  ];
  const { period, windows } = buildWorkloadProfile(records, {
    fromMs: BASE,
    toMs: BASE + 20 * MINUTE,
    windowMs: 10 * MINUTE,
    stepMs: 10 * MINUTE,
  });
  assert.equal(windows.length, 2);
  const [first, second] = windows;
  assert.equal(first?.requests, 2);
  assert.equal(first?.activeSessions, 1);
  assert.equal(first?.meanInFlight, 0.2);
  assert.equal(first?.freshPrefillTokens, 400);
  assert.equal(first?.cachedShare, 0.8);
  assert.equal(first?.cacheLossTokens, null);
  assert.equal(second?.requests, 1);
  assert.equal(second?.cachedPromptTokens, null);
  assert.equal(second?.freshPrefillTokens, null);
  assert.equal(second?.cacheLossTokens, 500);
  assert.equal(period.requests, 3);
  assert.equal(period.promptTokensP90, 3000);
});

test("counts windows the way the profile walks them", () => {
  assert.equal(
    workloadProfileWindowCount({
      fromMs: BASE,
      toMs: BASE + 60 * MINUTE,
      windowMs: 15 * MINUTE,
      stepMs: 5 * MINUTE,
    }),
    12,
  );
});

function window(
  startMinute: number,
  over: Partial<WorkloadProfileWindow> = {},
): WorkloadProfileWindow {
  return {
    startAt: new Date(BASE + startMinute * MINUTE).toISOString(),
    endAt: new Date(BASE + (startMinute + 15) * MINUTE).toISOString(),
    requests: 10,
    errors: 0,
    notServed: 0,
    activeSessions: 2,
    meanInFlight: 1,
    promptTokensP50: 1000,
    promptTokensP90: 2000,
    freshPrefillTokens: 5000,
    cachedPromptTokens: 5000,
    cachedShare: 0.5,
    completionTokensP50: 100,
    completionTokensP90: 200,
    cacheLossTokens: null,
    responseReuseTokens: null,
    ...over,
  };
}

test("ranks typical windows closest to the median, without overlaps or errors", () => {
  const ranked = rankWorkloadWindows(
    [
      window(0),
      window(5, { requests: 11 }),
      window(30, { requests: 40, activeSessions: 8, meanInFlight: 6 }),
      window(60, { errors: 1 }),
      window(90, { requests: 0 }),
      window(120),
    ],
    "typical",
    5,
  );
  assert.deepEqual(
    ranked.map((entry) => entry.startAt),
    [window(0).startAt, window(120).startAt, window(30).startAt],
  );
});

test("ranks peak windows by concurrency", () => {
  const ranked = rankWorkloadWindows(
    [window(0, { meanInFlight: 1 }), window(30, { meanInFlight: 5 })],
    "peak",
    1,
  );
  assert.equal(ranked[0]?.startAt, window(30).startAt);
});

test("linking groups compare reconstructed and client sessions", () => {
  const groups = workloadLinkingGroups([
    record({ traceId: "a", offsetMs: 0, clientSessionId: "s1" }),
    record({
      traceId: "b",
      offsetMs: MINUTE,
      sessionId: "a",
      parentTraceId: "a",
      clientSessionId: "s1",
    }),
    record({
      traceId: "c",
      offsetMs: 2 * MINUTE,
      sessionId: "a",
      parentTraceId: "b",
      clientSessionId: "s2",
    }),
    record({ traceId: "d", offsetMs: 3 * MINUTE, messageCount: null }),
  ]);
  assert.deepEqual(groups, [
    {
      sourceId: "src",
      sourceName: "agents",
      modelId: "agent",
      linkableRecords: 3,
      linkedRecords: 2,
      sessions: 1,
      clientSessions: 2,
      clientSessionPairs: 2,
      clientSessionAgreeing: 1,
    },
  ]);
});

test("summarizes a session from its records", () => {
  const summary = summarizeWorkloadSession([
    record({ traceId: "a", offsetMs: 0, targetName: "a" }),
    record({
      traceId: "b",
      offsetMs: MINUTE,
      sessionId: "a",
      outcome: "client-abort",
      promptTokens: 5000,
      targetName: "b",
    }),
    record({
      traceId: "c",
      offsetMs: 2 * MINUTE,
      sessionId: "a",
      outcome: "error",
      durationMs: 5 * MINUTE,
    }),
  ]);
  assert.equal(summary?.records, 3);
  assert.equal(summary?.replayable, 2);
  assert.equal(summary?.errors, 1);
  assert.equal(summary?.clientAborts, 1);
  assert.equal(summary?.maxPromptTokens, 5000);
  assert.equal(summary?.endedAt, new Date(BASE + 7 * MINUTE).toISOString());
  assert.deepEqual(summary?.targetNames, ["a", "b"]);
  assert.equal(summarizeWorkloadSession([]), null);
});
