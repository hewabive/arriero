import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComputeDomainCoordinator,
  ResourceLeaseAbortedError,
  type DomainAdmissionContext,
  type DomainAdmissionDecision,
  type DomainLease,
} from "./domain-coordinator.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

const alwaysAdmit = (): DomainAdmissionDecision => ({ type: "admit" });

const admitIfNoRunning = (
  context: DomainAdmissionContext,
): DomainAdmissionDecision =>
  context.holders.some((holder) => holder.running)
    ? { type: "wait" }
    : { type: "admit" };

function preemptLowerElseWait(myPriority: number) {
  return (context: DomainAdmissionContext): DomainAdmissionDecision => {
    const running = context.holders.filter((holder) => holder.running);
    if (running.some((holder) => holder.priority >= myPriority)) {
      return { type: "wait" };
    }
    const victims = running.filter(
      (holder) => holder.preemptible && holder.priority < myPriority,
    );
    if (victims.length > 0) {
      return { type: "preempt", leaseIds: victims.map((v) => v.leaseId) };
    }
    return { type: "admit" };
  };
}

function req(input: {
  domains?: string[];
  targetId: string;
  priority: number;
  preemptible?: boolean;
  decide: (context: DomainAdmissionContext) => DomainAdmissionDecision;
  signal?: AbortSignal;
}) {
  return {
    domains: input.domains ?? ["gpu0"],
    targetId: input.targetId,
    priority: input.priority,
    preemptible: input.preemptible ?? false,
    decide: input.decide,
    signal: input.signal,
  };
}

test("admits multiple coexisting holders on the same domain", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({ targetId: "a", priority: 100, decide: alwaysAdmit }),
  );
  const b = await coord.acquire(
    req({ targetId: "b", priority: 100, decide: alwaysAdmit }),
  );

  assert.equal(a.targetId, "a");
  assert.equal(b.targetId, "b");
  assert.deepEqual([...coord.busyTargetIds()].sort(), ["a", "b"]);
});

test("an exclusive policy serializes and admits the next on release", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({ targetId: "a", priority: 100, decide: admitIfNoRunning }),
  );
  const bState = track(
    coord.acquire(
      req({ targetId: "b", priority: 100, decide: admitIfNoRunning }),
    ),
  );

  await flush();
  assert.equal(bState.done, false);

  a.release();
  await flush();
  assert.equal(bState.done, true);
});

test("preempts a preemptible holder and resumes it after the preemptor", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({
      targetId: "a",
      priority: 100,
      preemptible: true,
      decide: admitIfNoRunning,
    }),
  );
  assert.equal(a.preemptSignal.aborted, false);

  const bState = track(
    coord.acquire(
      req({ targetId: "b", priority: 500, decide: preemptLowerElseWait(500) }),
    ),
  );
  await flush();

  assert.equal(a.preemptSignal.aborted, true);
  assert.equal(bState.done, false);

  const resumeState = track(a.yield());
  await flush();

  assert.equal(bState.done, true);
  const b = bState.value as DomainLease;
  assert.equal(resumeState.done, false);

  b.release();
  await flush();
  assert.equal(resumeState.done, true);
});

test("holds a lower-priority newcomer while a higher-priority holder runs", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({ targetId: "a", priority: 500, decide: alwaysAdmit }),
  );
  const bState = track(
    coord.acquire(
      req({ targetId: "b", priority: 100, decide: preemptLowerElseWait(100) }),
    ),
  );

  await flush();
  assert.equal(bState.done, false);
  assert.equal(a.preemptSignal.aborted, false);

  a.release();
  await flush();
  assert.equal(bState.done, true);
});

test("does not preempt a non-preemptible holder even when asked", async () => {
  const coord = new ComputeDomainCoordinator();
  const preemptRunning = (
    context: DomainAdmissionContext,
  ): DomainAdmissionDecision => {
    const running = context.holders.filter((holder) => holder.running);
    return running.length > 0
      ? { type: "preempt", leaseIds: running.map((holder) => holder.leaseId) }
      : { type: "admit" };
  };

  const a = await coord.acquire(
    req({
      targetId: "a",
      priority: 100,
      preemptible: false,
      decide: alwaysAdmit,
    }),
  );
  const bState = track(
    coord.acquire(
      req({ targetId: "b", priority: 500, decide: preemptRunning }),
    ),
  );

  await flush();
  assert.equal(a.preemptSignal.aborted, false);
  assert.equal(bState.done, false);

  a.release();
  await flush();
  assert.equal(bState.done, true);
});

test("disjoint domains run in parallel; overlapping domains contend", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({
      targetId: "a",
      domains: ["gpu0", "gpu1"],
      priority: 100,
      decide: admitIfNoRunning,
    }),
  );

  const disjoint = await coord.acquire(
    req({
      targetId: "disjoint",
      domains: ["gpu2"],
      priority: 100,
      decide: admitIfNoRunning,
    }),
  );
  assert.equal(disjoint.targetId, "disjoint");

  const overlapState = track(
    coord.acquire(
      req({
        targetId: "overlap",
        domains: ["gpu1"],
        priority: 100,
        decide: admitIfNoRunning,
      }),
    ),
  );
  await flush();
  assert.equal(overlapState.done, false);

  a.release();
  await flush();
  assert.equal(overlapState.done, true);
});

test("aborting a waiting lease rejects and removes it", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({ targetId: "a", priority: 100, decide: admitIfNoRunning }),
  );
  const controller = new AbortController();
  const waiterState = track(
    coord.acquire(
      req({
        targetId: "b",
        priority: 100,
        decide: admitIfNoRunning,
        signal: controller.signal,
      }),
    ),
  );

  await flush();
  assert.equal(waiterState.done, false);

  controller.abort();
  await flush();
  assert.equal(waiterState.done, true);
  assert.ok(waiterState.error instanceof ResourceLeaseAbortedError);

  a.release();
  await flush();
});

test("busyTargetIds reports running holders only, not waiters or maintenance", async () => {
  const coord = new ComputeDomainCoordinator();
  const a = await coord.acquire(
    req({ targetId: "a", priority: 100, decide: admitIfNoRunning }),
  );
  track(
    coord.acquire(
      req({ targetId: "b", priority: 100, decide: admitIfNoRunning }),
    ),
  );
  await flush();

  assert.deepEqual([...coord.busyTargetIds()], ["a"]);
  a.release();
});

test("tryAcquireMaintenance succeeds only when the domains are idle and blocks acquires", async () => {
  const coord = new ComputeDomainCoordinator();

  const maintenance = coord.tryAcquireMaintenance(["gpu0"]);
  assert.ok(maintenance);
  assert.deepEqual([...coord.busyTargetIds()], []);

  const waiterState = track(
    coord.acquire(req({ targetId: "a", priority: 100, decide: alwaysAdmit })),
  );
  await flush();
  assert.equal(waiterState.done, false);
  assert.equal(coord.tryAcquireMaintenance(["gpu0"]), null);

  maintenance?.release();
  await flush();
  assert.equal(waiterState.done, true);
});

const admitIfUnderTwo = (
  context: DomainAdmissionContext,
): DomainAdmissionDecision =>
  context.holders.filter((holder) => holder.running).length < 2
    ? { type: "admit" }
    : { type: "wait" };

test("prefers a resident (affine) waiter over a swap waiter at equal priority", async () => {
  const coord = new ComputeDomainCoordinator();
  const resident = await coord.acquire(
    req({ targetId: "x", priority: 100, decide: admitIfUnderTwo }),
  );
  const filler = await coord.acquire(
    req({ targetId: "z", priority: 100, decide: admitIfUnderTwo }),
  );

  const swap = track(
    coord.acquire(
      req({ targetId: "y", priority: 100, decide: admitIfUnderTwo }),
    ),
  );
  const affine = track(
    coord.acquire(
      req({ targetId: "x", priority: 100, decide: admitIfUnderTwo }),
    ),
  );
  await flush();
  assert.equal(swap.done, false);
  assert.equal(affine.done, false);

  filler.release();
  await flush();
  assert.equal(affine.done, true);
  assert.equal(swap.done, false);

  resident.release();
  (affine.value as DomainLease | undefined)?.release();
  await flush();
  assert.equal(swap.done, true);
});

test("a starved swap waiter overrides affinity once past the fairness window", async () => {
  const coord = new ComputeDomainCoordinator(0);
  const resident = await coord.acquire(
    req({ targetId: "x", priority: 100, decide: admitIfUnderTwo }),
  );
  const filler = await coord.acquire(
    req({ targetId: "z", priority: 100, decide: admitIfUnderTwo }),
  );

  const swap = track(
    coord.acquire(
      req({ targetId: "y", priority: 100, decide: admitIfUnderTwo }),
    ),
  );
  const affine = track(
    coord.acquire(
      req({ targetId: "x", priority: 100, decide: admitIfUnderTwo }),
    ),
  );
  await flush();

  filler.release();
  await flush();
  assert.equal(swap.done, true);
  assert.equal(affine.done, false);

  resident.release();
  (swap.value as DomainLease | undefined)?.release();
  await flush();
  assert.equal(affine.done, true);
});
