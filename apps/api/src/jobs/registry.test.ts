import assert from "node:assert/strict";
import test from "node:test";

import {
  anyActiveJobs,
  getActiveJob,
  listActiveJobs,
  registerActiveJob,
  resetActiveJobs,
  shutdownActiveJobs,
} from "./registry.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDone!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return { promise, resolve: resolveDone };
}

test("registry tracks active jobs per domain and entity", (t) => {
  t.after(resetActiveJobs);
  const build = deferred();
  const source = deferred();
  registerActiveJob({
    domain: "build",
    jobId: "b1",
    cancel: () => {},
    completion: build.promise,
  });
  registerActiveJob({
    domain: "source",
    entityId: "llama-cpp",
    jobId: "s1",
    cancel: () => {},
    completion: source.promise,
  });

  assert.equal(getActiveJob("build")?.jobId, "b1");
  assert.equal(getActiveJob("source", "llama-cpp")?.jobId, "s1");
  assert.equal(getActiveJob("source"), null);
  assert.equal(listActiveJobs().length, 2);
  assert.equal(listActiveJobs("build").length, 1);
  assert.ok(anyActiveJobs());
  assert.ok(anyActiveJobs(["source"]));
  assert.ok(!anyActiveJobs(["envs"]));
});

test("registry rejects a second job for the same domain and entity", (t) => {
  t.after(resetActiveJobs);
  const first = deferred();
  registerActiveJob({
    domain: "build",
    jobId: "b1",
    cancel: () => {},
    completion: first.promise,
  });

  assert.throws(
    () =>
      registerActiveJob({
        domain: "build",
        jobId: "b2",
        cancel: () => {},
        completion: Promise.resolve(),
      }),
    /already active: b1/,
  );
});

test("registry deregisters a job when its completion settles", async (t) => {
  t.after(resetActiveJobs);
  const work = deferred();
  registerActiveJob({
    domain: "envs",
    jobId: "e1",
    cancel: () => {},
    completion: work.promise,
  });

  work.resolve();
  await work.promise;
  await new Promise((resolveDone) => setTimeout(resolveDone, 0));
  assert.equal(getActiveJob("envs"), null);
});

test("registry deregisters a job whose completion rejects", async (t) => {
  t.after(resetActiveJobs);
  let rejectDone!: (error: Error) => void;
  const completion = new Promise<void>((_resolvePromise, rejectPromise) => {
    rejectDone = rejectPromise;
  });
  registerActiveJob({
    domain: "envs",
    jobId: "e1",
    cancel: () => {},
    completion,
  });

  rejectDone(new Error("boom"));
  await completion.catch(() => undefined);
  await new Promise((resolveDone) => setTimeout(resolveDone, 0));
  assert.equal(getActiveJob("envs"), null);
});

test("shutdownActiveJobs cancels everything and waits for completion", async (t) => {
  t.after(resetActiveJobs);
  const work = deferred();
  let canceled = false;
  registerActiveJob({
    domain: "build",
    jobId: "b1",
    cancel: () => {
      canceled = true;
      work.resolve();
    },
    completion: work.promise,
  });

  const stopped = await shutdownActiveJobs(5_000);
  assert.equal(stopped, 1);
  assert.ok(canceled);
});

test("shutdownActiveJobs gives up after the timeout", async (t) => {
  t.after(resetActiveJobs);
  registerActiveJob({
    domain: "build",
    jobId: "b1",
    cancel: () => {},
    completion: new Promise(() => {}),
  });

  const started = Date.now();
  const stopped = await shutdownActiveJobs(50);
  assert.equal(stopped, 1);
  assert.ok(Date.now() - started < 2_000);
});

test("shutdownActiveJobs returns zero when idle", async () => {
  assert.equal(await shutdownActiveJobs(50), 0);
});
