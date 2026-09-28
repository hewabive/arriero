import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type {
  ApiProxyRequestTrace,
  ApiProxyTraceFile,
  WorkloadRecord,
} from "@arriero/core";

import { saveApiProxyRequestFile } from "../proxy/request-files.js";
import {
  clearApiProxyTraceHistory,
  insertApiProxyTrace,
} from "../proxy/traces-repository.js";
import { runWorkloadIndexPass } from "./indexer.js";
import { WORKLOAD_NORMALIZATION_VERSION } from "./record-analysis.js";
import {
  clearWorkloadRecords,
  getWorkloadRecord,
  listWorkloadRecords,
  readWorkloadIndexState,
  writeWorkloadIndexState,
} from "./repository.js";

const BASE = Date.parse("2026-09-20T10:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

const routePaths = {
  "chat.completions": "/v1/chat/completions",
  messages: "/v1/messages",
  "messages.count_tokens": "/v1/messages/count_tokens",
};

type CapturedEndpoint = keyof typeof routePaths;

function capture(
  id: string,
  at: string,
  body: unknown,
  endpoint: CapturedEndpoint = "chat.completions",
): ApiProxyTraceFile {
  return saveApiProxyRequestFile({
    traceId: id,
    traceAt: at,
    kind: "capture-request",
    label: null,
    protocol: endpoint === "chat.completions" ? "openai" : "anthropic",
    endpoint,
    routePath: routePaths[endpoint],
    modelId: "agent",
    data: body,
  });
}

function trace(
  over: Partial<ApiProxyRequestTrace> & { id: string; at: string },
): ApiProxyRequestTrace {
  return {
    protocol: "openai",
    translated: false,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "agent",
    sourceId: "src-1",
    sourceName: "agents",
    stream: true,
    targetId: "target-a",
    targetName: "a",
    slotId: null,
    cacheOrigin: null,
    cache: null,
    resumed: false,
    textReplacementCount: 0,
    routeTrace: [
      {
        kind: "capture-request",
        pipelineId: "p",
        pipelineName: "p",
        nodeId: "capture",
        nodeName: null,
        port: "next",
        detail: "request saved",
      },
    ],
    files: [],
    schedulerActions: [],
    displacedTargetIds: [],
    usage: null,
    streamHealth: null,
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    translationWarnings: [],
    durationMs: 1000,
    queueMs: null,
    ttftMs: 120,
    ...over,
  };
}

function usage(promptTokens: number, cacheReadTokens: number | null) {
  return {
    promptTokens,
    cacheReadTokens,
    cacheCreationTokens: null,
    completionTokens: 50,
    genMs: 0,
    ratePerSecond: null,
    prefillMs: null,
    promptPerSecond: null,
  };
}

function recorded(input: {
  id: string;
  offsetMs: number;
  messages: unknown[];
  system?: string;
  usage?: ReturnType<typeof usage>;
  durationMs?: number;
}): void {
  const at = iso(input.offsetMs);
  const body = {
    model: "agent",
    messages: [
      { role: "system", content: input.system ?? "agent" },
      ...input.messages,
    ],
  };
  insertApiProxyTrace(
    trace({
      id: input.id,
      at,
      durationMs: input.durationMs ?? 1000,
      usage: input.usage ?? null,
      files: [capture(input.id, at, body)],
    }),
  );
}

function recordedAnthropic(input: {
  id: string;
  offsetMs: number;
  endpoint: "messages" | "messages.count_tokens";
  messages: unknown[];
  usage?: ReturnType<typeof usage>;
}): void {
  const at = iso(input.offsetMs);
  const body = { model: "agent", system: "agent", messages: input.messages };
  insertApiProxyTrace(
    trace({
      id: input.id,
      at,
      protocol: "anthropic",
      translated: true,
      endpoint: input.endpoint,
      routePath: routePaths[input.endpoint],
      stream: input.endpoint === "messages",
      usage: input.usage ?? null,
      files: [capture(input.id, at, body, input.endpoint)],
    }),
  );
}

function byTrace(): Map<string, WorkloadRecord> {
  return new Map(
    listWorkloadRecords({}).map((record) => [record.traceId, record]),
  );
}

const HOUR = 60 * 60 * 1000;
const later = new Date(BASE + 24 * HOUR);

const turn1 = [{ role: "user", content: "fix the test" }];
const turn2 = [
  ...turn1,
  { role: "assistant", content: "reading" },
  { role: "user", content: "file contents" },
];
const turn3 = [
  ...turn2,
  { role: "assistant", content: "patching" },
  { role: "user", content: "patched" },
];

beforeEach(() => {
  clearApiProxyTraceHistory();
  clearWorkloadRecords();
  writeWorkloadIndexState({
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
    lastPassAt: null,
    lastPassIndexed: 0,
  });
});

test("links a session and derives think time and cache metrics", async () => {
  recorded({
    id: "r1",
    offsetMs: 0,
    messages: turn1,
    usage: usage(1000, 0),
  });
  recorded({
    id: "r2",
    offsetMs: 3000,
    messages: turn2,
    usage: usage(1500, 1000),
  });
  recorded({
    id: "r3",
    offsetMs: 9000,
    messages: turn3,
    usage: usage(2000, 400),
  });
  recorded({ id: "other", offsetMs: 20_000, system: "other", messages: turn1 });

  const result = await runWorkloadIndexPass(later);
  assert.equal(result.indexed, 4);
  const records = byTrace();
  assert.equal(records.get("r1")?.parentTraceId, null);
  assert.equal(records.get("r2")?.parentTraceId, "r1");
  assert.equal(records.get("r2")?.sharedMessages, 2);
  assert.equal(records.get("r3")?.parentTraceId, "r2");
  assert.equal(records.get("r3")?.sessionId, "r1");
  assert.equal(records.get("other")?.sessionId, "other");
  assert.equal(records.get("r2")?.thinkTimeMs, 2000);
  assert.equal(records.get("r3")?.thinkTimeMs, 5000);
  assert.equal(records.get("r2")?.cacheLossTokens, 0);
  assert.equal(records.get("r3")?.cacheLossTokens, 1100);
  assert.equal(records.get("r3")?.responseReuseTokens, 0);
  assert.equal(records.get("r1")?.issue, null);
  assert.equal(records.get("r1")?.outcome, "success");
});

test("a token count carrying the conversation never joins its session", async () => {
  recordedAnthropic({
    id: "m1",
    offsetMs: 0,
    endpoint: "messages",
    messages: turn1,
    usage: usage(1000, 0),
  });
  recordedAnthropic({
    id: "m2",
    offsetMs: 5000,
    endpoint: "messages",
    messages: turn2,
    usage: usage(1500, 1000),
  });
  recordedAnthropic({
    id: "count",
    offsetMs: 8000,
    endpoint: "messages.count_tokens",
    messages: turn2,
  });
  recordedAnthropic({
    id: "m3",
    offsetMs: 60_000,
    endpoint: "messages",
    messages: turn3,
    usage: usage(2000, 1400),
  });

  assert.equal((await runWorkloadIndexPass(later)).indexed, 4);
  const records = byTrace();
  assert.equal(records.get("m2")?.parentTraceId, "m1");
  assert.equal(records.get("m3")?.parentTraceId, "m2");
  assert.equal(records.get("m3")?.sessionId, "m1");
  assert.equal(records.get("m3")?.thinkTimeMs, 54_000);
  assert.equal(records.get("m3")?.cacheLossTokens, 100);
  const count = getWorkloadRecord("count");
  assert.equal(count?.issue, "unsupported-operation");
  assert.equal(count?.messageCount, null);
  assert.equal(count?.parentTraceId, null);
  assert.equal(count?.sessionId, "count");
});

test("a second pass indexes nothing new", async () => {
  recorded({ id: "r1", offsetMs: 0, messages: turn1 });
  assert.equal((await runWorkloadIndexPass(later)).indexed, 1);
  assert.equal((await runWorkloadIndexPass(later)).indexed, 0);
  assert.equal(readWorkloadIndexState().lastPassIndexed, 0);
});

test("waits until a trace has settled", async () => {
  recorded({ id: "r1", offsetMs: 0, messages: turn1, durationMs: 50_000 });
  assert.equal(
    (await runWorkloadIndexPass(new Date(BASE + 60_000))).indexed,
    0,
  );
  assert.equal(
    (await runWorkloadIndexPass(new Date(BASE + 120_000))).indexed,
    1,
  );
});

test("picks up a late insert inside the trailing window", async () => {
  recorded({ id: "r1", offsetMs: 0, messages: turn1 });
  recorded({ id: "r3", offsetMs: 9000, messages: turn3 });
  assert.equal((await runWorkloadIndexPass(later)).indexed, 2);
  recorded({ id: "r2", offsetMs: 3000, messages: turn2 });
  assert.equal((await runWorkloadIndexPass(later)).indexed, 1);
  assert.equal(byTrace().get("r2")?.parentTraceId, "r1");
});

test("records a capture that can no longer be read", async () => {
  const at = iso(0);
  insertApiProxyTrace(
    trace({
      id: "gone",
      at,
      files: [
        {
          name: "01-capture-request.json",
          path: "agent/missing/01-capture-request.json",
          kind: "capture-request",
          label: null,
          bytes: 10,
          createdAt: at,
        },
      ],
    }),
  );
  await runWorkloadIndexPass(later);
  const record = byTrace().get("gone");
  assert.equal(record?.issue, "capture-unreadable");
  assert.equal(record?.messageCount, null);
  assert.equal(record?.sessionId, "gone");
});

test("prunes past retention and rebuilds on a normalization change", async () => {
  recorded({ id: "r1", offsetMs: 0, messages: turn1 });
  recorded({ id: "r2", offsetMs: 3000, messages: turn2 });
  await runWorkloadIndexPass(later);
  writeWorkloadIndexState({
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION - 1,
    lastPassAt: null,
    lastPassIndexed: 0,
  });
  const rebuilt = await runWorkloadIndexPass(later);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.indexed, 2);
  assert.equal(byTrace().get("r2")?.parentTraceId, "r1");
  const expired = await runWorkloadIndexPass(new Date(BASE + 40 * 24 * HOUR));
  assert.equal(expired.pruned, 2);
  assert.equal(listWorkloadRecords({}).length, 0);
});

test("prunes by the retention cutoff alone", async () => {
  recorded({ id: "r1", offsetMs: 0, messages: turn1 });
  recorded({ id: "r2", offsetMs: 3000, messages: turn2 });
  await runWorkloadIndexPass(later);
  clearApiProxyTraceHistory();
  assert.equal((await runWorkloadIndexPass(later)).pruned, 0);
  const pass = await runWorkloadIndexPass(
    new Date(BASE + 30 * 24 * HOUR + 2000),
  );
  assert.equal(pass.pruned, 1);
  assert.deepEqual(
    listWorkloadRecords({}).map((record) => record.traceId),
    ["r2"],
  );
});
