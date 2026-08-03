import assert from "node:assert/strict";
import test from "node:test";

import { markJobStep, patchSteps, type JobStepBase } from "./steps.js";
import { createJobStore, type BackgroundJobBase } from "./store.js";

type TestStep = JobStepBase & { name: "one" | "two" };

type TestJob = BackgroundJobBase & {
  steps: TestStep[];
  currentStep: TestStep["name"] | null;
};

function pendingStep(name: TestStep["name"]): TestStep {
  return {
    name,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
}

function makeJob(): TestJob {
  return {
    id: "job-1",
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    error: null,
    steps: [pendingStep("one"), pendingStep("two")],
    currentStep: null,
  };
}

test("patchSteps replaces only the named step", () => {
  const steps = [pendingStep("one"), pendingStep("two")];
  const next = patchSteps(steps, "two", { status: "running" });

  assert.equal(next[0]?.status, "pending");
  assert.equal(next[1]?.status, "running");
  assert.equal(steps[1]?.status, "pending");
});

test("markJobStep sets currentStep for a running step and keeps it otherwise", () => {
  const store = createJobStore<TestJob>({ historyLimit: 5 });
  store.insert(makeJob());

  const started = markJobStep<TestStep, TestJob>(store, "job-1", "one", {
    status: "running",
    startedAt: "2026-01-01T00:00:01Z",
  });
  assert.equal(started.currentStep, "one");

  const finished = markJobStep<TestStep, TestJob>(store, "job-1", "one", {
    status: "succeeded",
    finishedAt: "2026-01-01T00:00:02Z",
    exitCode: 0,
  });
  assert.equal(finished.currentStep, "one");
  assert.equal(finished.steps[0]?.status, "succeeded");
  assert.equal(finished.steps[0]?.exitCode, 0);
});

test("markJobStep throws for a missing job", () => {
  const store = createJobStore<TestJob>({ historyLimit: 5 });
  assert.throws(
    () =>
      markJobStep<TestStep, TestJob>(store, "ghost", "one", {
        status: "running",
      }),
    /job not found: ghost/,
  );
});
