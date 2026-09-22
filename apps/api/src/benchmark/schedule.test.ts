import { BenchmarkScenarioSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import {
  runBenchmarkSchedule,
  type ScheduledBenchmarkRequest,
} from "./schedule.js";

function deferred() {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: () => {
      assert.ok(resolve);
      resolve();
    },
  };
}

function scenario(overrides: Record<string, unknown> = {}) {
  return BenchmarkScenarioSchema.parse({
    target: { kind: "instance", instanceName: "test" },
    composition: [
      { promptId: "short", count: 1 },
      { promptId: "long", count: 1 },
    ],
    mode: "sustained",
    totalRequests: 5,
    ...overrides,
  });
}

test("sustained clients replenish independently and share an exact request budget", async () => {
  const slow = deferred();
  const fastFinished = deferred();
  const started: ScheduledBenchmarkRequest[] = [];
  let slowFinished = false;
  const completion = runBenchmarkSchedule({
    scenario: scenario(),
    clients: 2,
    signal: new AbortController().signal,
    run: async (request) => {
      started.push(request);
      if (request.client === 1) {
        await slow.promise;
        slowFinished = true;
      } else {
        assert.equal(slowFinished, false);
        if (request.sequence === 4) fastFinished.resolve();
      }
    },
  });
  await fastFinished.promise;
  assert.deepEqual(
    started.map((request) => request.client),
    [0, 1, 0, 0, 0],
  );
  slow.resolve();
  await completion;
  assert.deepEqual(
    started.map((request) => request.sequence),
    [0, 1, 2, 3, 4],
  );
  assert.ok(started.every((request) => request.repetition === 0));
});

test("cancel stops replenishment and drains every active client", async () => {
  const controller = new AbortController();
  let started = 0;
  let active = 0;
  const completion = runBenchmarkSchedule({
    scenario: scenario(),
    clients: 2,
    signal: controller.signal,
    run: async ({ signal }) => {
      started += 1;
      active += 1;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      active -= 1;
    },
  });
  assert.equal(active, 2);
  controller.abort();
  await completion;
  assert.equal(started, 2);
  assert.equal(active, 0);
});

test("a scheduling failure aborts siblings before propagating", async () => {
  let active = 0;
  const completion = runBenchmarkSchedule({
    scenario: scenario(),
    clients: 2,
    signal: new AbortController().signal,
    run: async ({ client, signal }) => {
      active += 1;
      try {
        if (client === 0) {
          await Promise.resolve();
          throw new Error("storage failed");
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      } finally {
        active -= 1;
      }
    },
  });
  await assert.rejects(completion, /storage failed/);
  assert.equal(active, 0);
});

test("sequential mode preserves repetition boundaries", async () => {
  const order: number[][] = [];
  let active = false;
  await runBenchmarkSchedule({
    scenario: scenario({ mode: "sequential", repetitions: 2 }),
    clients: 2,
    signal: new AbortController().signal,
    run: async ({ client, repetition }) => {
      assert.equal(active, false);
      active = true;
      order.push([repetition, client]);
      await Promise.resolve();
      active = false;
    },
  });
  assert.deepEqual(order, [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ]);
});

test("sustained scenarios require a budget covering the initial clients", () => {
  for (const override of [
    { totalRequests: undefined },
    { totalRequests: 1 },
    { repetitions: 2 },
    { requestTimeoutMs: 0 },
    { totalRequests: 100001 },
  ]) {
    assert.throws(() => scenario(override));
  }
  assert.equal(scenario().requestTimeoutMs, 300000);
  assert.equal(
    scenario({ mode: "parallel", totalRequests: undefined }).totalRequests,
    undefined,
  );
});
