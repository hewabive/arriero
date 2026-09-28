import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decomposeWorkloadBody,
  rebuildWorkloadBody,
  workloadBlobHash,
  workloadDatasetRecord,
} from "./dataset-codec.js";
import type { ReplayableWorkloadRecord } from "./record-analysis.js";

function collect() {
  const blobs = new Map<string, string>();
  return {
    blobs,
    sink: (hash: string, json: string) => {
      blobs.set(hash, json);
    },
    read: (hash: string) => JSON.parse(blobs.get(hash) ?? "null") as unknown,
  };
}

test("an OpenAI body splits into blobs and rebuilds equal", () => {
  const store = collect();
  const body = {
    model: "agent",
    stream: true,
    max_tokens: 4096,
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "system", content: "agent" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        ],
      },
    ],
  };
  const split = decomposeWorkloadBody("openai", body, store.sink);
  assert.ok(split);
  assert.equal(split.system, null);
  assert.deepEqual(Object.keys(split.fields).sort(), [
    "max_tokens",
    "model",
    "stream",
  ]);
  assert.deepEqual(rebuildWorkloadBody(split, store.read), body);
  for (const [hash, json] of store.blobs) {
    assert.equal(workloadBlobHash(json), hash);
  }
});

test("an Anthropic system is its own blob and repeated content is stored once", () => {
  const store = collect();
  const system = [{ type: "text", text: "You are a coding agent." }];
  const first = decomposeWorkloadBody(
    "anthropic",
    { system, messages: [{ role: "user", content: "u1" }] },
    store.sink,
  );
  const second = decomposeWorkloadBody(
    "anthropic",
    {
      system,
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    },
    store.sink,
  );
  assert.ok(first && second);
  assert.equal(first.system, second.system);
  assert.equal(first.messages[0], second.messages[0]);
  assert.equal(store.blobs.size, 3);
  assert.equal(
    decomposeWorkloadBody("anthropic", { prompt: "x" }, store.sink),
    null,
  );
});

test("dataset records keep offsets from the window and think time between replays", () => {
  const base = Date.parse("2026-09-20T10:00:00.000Z");
  const record = (
    at: number,
    durationMs: number,
  ): ReplayableWorkloadRecord => ({
    traceId: `t${at}`,
    at: new Date(base + at).toISOString(),
    endAt: new Date(base + at + durationMs).toISOString(),
    durationMs,
    sourceId: null,
    sourceName: null,
    modelId: "agent",
    targetId: "a",
    targetName: "a",
    protocol: "openai",
    endpoint: "chat.completions",
    outcome: "client-abort",
    issue: null,
    capturePath: null,
    messageCount: 1,
    sessionId: "s",
    parentTraceId: null,
    sharedMessages: null,
    clientSessionId: null,
    promptTokens: 10,
    cacheReadTokens: 0,
    completionTokens: 5,
    ttftMs: 50,
    thinkTimeMs: null,
    cacheLossTokens: null,
    responseReuseTokens: null,
  });
  const body = { fields: {}, messages: [], tools: null, system: null };
  const captured = {
    protocol: "openai" as const,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
  };
  const firstRecord = record(5000, 2000);
  const second = workloadDatasetRecord({
    record: record(9000, 1000),
    captured,
    body,
    windowFromMs: base,
    previous: firstRecord,
  });
  assert.equal(second.offsetMs, 9000);
  assert.equal(second.thinkTimeMs, 2000);
  assert.equal(second.outcome, "client-abort");
  const first = workloadDatasetRecord({
    record: firstRecord,
    captured,
    body,
    windowFromMs: base + 60_000,
    previous: null,
  });
  assert.equal(first.offsetMs, 0);
  assert.equal(first.thinkTimeMs, null);
});
