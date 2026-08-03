import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobStore,
  createLatestJobStore,
  type BackgroundJobBase,
} from "./store.js";

type TestJob = BackgroundJobBase & { note: string; tags: string[] };

function job(
  id: string,
  startedAt: string,
  status: TestJob["status"],
): TestJob {
  return {
    id,
    status,
    startedAt,
    finishedAt: status === "running" ? null : startedAt,
    error: null,
    note: "",
    tags: [],
  };
}

test("job store clones at both boundaries", () => {
  const store = createJobStore<TestJob>({ historyLimit: 10 });
  const original = job("a", "2026-01-01T00:00:00Z", "running");
  const inserted = store.insert(original);
  original.tags.push("mutated-input");
  inserted.tags.push("mutated-output");

  const stored = store.get("a");
  assert.ok(stored);
  assert.deepEqual(stored.tags, []);
});

test("job store patch merges and preserves id", () => {
  const store = createJobStore<TestJob>({ historyLimit: 10 });
  store.insert(job("a", "2026-01-01T00:00:00Z", "running"));

  const patched = store.patch("a", {
    status: "succeeded",
    finishedAt: "2026-01-01T00:01:00Z",
    id: "hijacked",
  } as Partial<TestJob>);

  assert.ok(patched);
  assert.equal(patched.id, "a");
  assert.equal(patched.status, "succeeded");
  assert.equal(patched.finishedAt, "2026-01-01T00:01:00Z");
  assert.equal(store.patch("missing", { note: "x" }), null);
});

test("job store lists newest first with clamped limit", () => {
  const store = createJobStore<TestJob>({ historyLimit: 10 });
  store.insert(job("a", "2026-01-01T00:00:00Z", "succeeded"));
  store.insert(job("b", "2026-01-03T00:00:00Z", "succeeded"));
  store.insert(job("c", "2026-01-02T00:00:00Z", "succeeded"));

  assert.deepEqual(
    store.list().map((item) => item.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    store.list(0).map((item) => item.id),
    ["b"],
  );
});

test("job store trims oldest finished jobs beyond the history limit", () => {
  const store = createJobStore<TestJob>({ historyLimit: 2 });
  store.insert(job("old", "2026-01-01T00:00:00Z", "failed"));
  store.insert(job("mid", "2026-01-02T00:00:00Z", "succeeded"));
  store.insert(job("new", "2026-01-03T00:00:00Z", "succeeded"));

  assert.equal(store.get("old"), null);
  assert.ok(store.get("mid"));
  assert.ok(store.get("new"));
});

test("job store never trims running jobs", () => {
  const store = createJobStore<TestJob>({ historyLimit: 1 });
  store.insert(job("r1", "2026-01-01T00:00:00Z", "running"));
  store.insert(job("r2", "2026-01-02T00:00:00Z", "running"));
  store.insert(job("r3", "2026-01-03T00:00:00Z", "running"));

  assert.equal(store.list().length, 3);
});

test("latest job store keeps one job per key", () => {
  const store = createLatestJobStore<TestJob>();
  store.start("source-a", job("first", "2026-01-01T00:00:00Z", "succeeded"));
  store.start("source-a", job("second", "2026-01-02T00:00:00Z", "running"));

  assert.equal(store.get("source-a")?.id, "second");
  assert.equal(store.get("source-b"), null);

  const patched = store.patch("source-a", { status: "canceled" });
  assert.equal(patched?.status, "canceled");
  assert.equal(store.patch("source-b", { note: "x" }), null);
});
