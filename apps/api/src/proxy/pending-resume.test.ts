import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ApiProxyPendingResumeStore } from "./pending-resume.js";
import type { ApiProxyStreamSessionEntry } from "./stream-session.js";

function session(
  overrides: Partial<ApiProxyStreamSessionEntry> = {},
): ApiProxyStreamSessionEntry {
  return {
    inflightId: "req-1",
    convId: "conv-1",
    instanceId: "instance-a",
    targetId: "target-a",
    modelId: "model-a",
    baseUrl: "http://127.0.0.1:8080",
    authHeaders: {},
    resumeKey: "key-1",
    protocol: "openai",
    endpoint: "chat.completions",
    stream: true,
    startedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

type FetchCall = { url: string; method: string | undefined; body: string };

function storeAt(
  dir: string,
  options: {
    now?: () => number;
    claimWindowMs?: number;
    lookup?: (call: FetchCall) => Response;
  } = {},
) {
  const calls: FetchCall[] = [];
  const store = new ApiProxyPendingResumeStore({
    file: join(dir, "pending-resume.json"),
    now: options.now ?? (() => 1_000),
    claimWindowMs: options.claimWindowMs ?? 180_000,
    fetchImpl: async (url, init) => {
      const call = {
        url,
        method: init.method,
        body: typeof init.body === "string" ? init.body : "",
      };
      calls.push(call);
      return options.lookup?.(call) ?? new Response("[]", { status: 200 });
    },
  });
  return { store, calls };
}

test("persist and adopt round-trip entries through the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-resume-"));
  try {
    const lookup = (call: FetchCall) =>
      call.method === "POST"
        ? new Response(
            JSON.stringify([
              { conversation_id: "conv-1", is_done: false, total_bytes: 10 },
            ]),
            { status: 200 },
          )
        : new Response("[]", { status: 200 });
    const writer = storeAt(dir);
    assert.equal(
      writer.store.persist([
        session({ convId: "conv-1", resumeKey: "key-1" }),
        session({ convId: "conv-2", resumeKey: "key-2", inflightId: "req-2" }),
      ]),
      2,
    );

    const reader = storeAt(dir, { lookup });
    const adopted = reader.store.adopt();
    assert.equal(adopted.adopted, 2);
    assert.equal(existsSync(join(dir, "pending-resume.json")), false);
    await adopted.verified;
    assert.equal(reader.store.size(), 1);
    assert.notEqual(reader.store.claim("key-1"), null);
    assert.equal(reader.store.claim("key-2"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persist with no sessions removes a stale file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-resume-"));
  try {
    const { store } = storeAt(dir);
    store.persist([session()]);
    assert.equal(store.persist([]), 0);
    assert.equal(existsSync(join(dir, "pending-resume.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed lookup drops that instance's entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-resume-"));
  try {
    storeAt(dir).store.persist([session({ convId: "conv-1" })]);
    const reader = storeAt(dir, {
      lookup: () => new Response("not found", { status: 404 }),
    });
    const adopted = reader.store.adopt();
    await adopted.verified;
    assert.equal(reader.store.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed entries stay protected until finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-resume-"));
  try {
    const lookup = () =>
      new Response(JSON.stringify([{ conversation_id: "conv-1" }]), {
        status: 200,
      });
    storeAt(dir).store.persist([session({ convId: "conv-1" })]);
    const reader = storeAt(dir, { lookup });
    await reader.store.adopt().verified;

    const entry = reader.store.claim("key-1");
    assert.notEqual(entry, null);
    assert.deepEqual(reader.store.targetIds(), ["target-a"]);

    const deletesBefore = reader.calls.filter(
      (call) => call.method === "DELETE",
    ).length;
    reader.store.finish(entry!, { evict: true });
    assert.deepEqual(reader.store.targetIds(), []);
    const deletes = reader.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, deletesBefore + 1);
    assert.match(deletes.at(-1)!.url, /\/v1\/stream\/conv-1$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep deletes expired sessions and lifts protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-resume-"));
  try {
    const lookup = () =>
      new Response(JSON.stringify([{ conversation_id: "conv-1" }]), {
        status: 200,
      });
    storeAt(dir).store.persist([session({ convId: "conv-1" })]);
    let at = 1_000;
    const reader = storeAt(dir, { lookup, now: () => at, claimWindowMs: 500 });
    await reader.store.adopt().verified;

    assert.equal(reader.store.sweep(), 0);
    at = 2_000;
    assert.equal(reader.store.sweep(), 1);
    assert.equal(reader.store.size(), 0);
    assert.deepEqual(reader.store.targetIds(), []);
    assert.equal(
      reader.calls.filter((call) => call.method === "DELETE").length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
