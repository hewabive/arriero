import {
  ApiProxySchedulerPlanRequestSchema,
  type ApiProxySchedulerPlan,
  type ApiProxySchedulerPlanRequest,
} from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { buildDomainAdmissionDecider } from "./domain-admission.js";
import {
  ComputeDomainCoordinator,
  type DomainLease,
} from "./domain-coordinator.js";
import { DomainSwapCoordinator } from "./domain-swap-coordinator.js";
import { planApiProxyRequest } from "./scheduler.js";

const POOL = {
  poolId: "gpu0",
  kind: "gpu" as const,
  budgetBytes: 100,
  usedByOthersBytes: 0,
};

type World = { resident: Map<string, { busy: boolean }> };

const MODELS = ["m1", "m2", "m3"];

const IDLE_SINCE: Record<string, string> = {
  m1: "2026-05-30T10:00:05.000Z",
  m2: "2026-05-30T10:00:00.000Z",
  m3: "2026-05-30T10:00:00.000Z",
};

function planTarget(id: string, world: World) {
  const residency = world.resident.get(id);
  return {
    id,
    name: id,
    endpointId: `instance:${id}`,
    instanceId: id,
    model: id,
    role: "interactive" as const,
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
    draws: [{ poolId: "gpu0", bytes: 40 }],
    runtime: {
      targetId: id,
      kind: "managed-instance",
      endpointId: `instance:${id}`,
      baseUrl: `http://127.0.0.1/${id}/v1`,
      instanceId: id,
      model: id,
      state: residency ? ("ready" as const) : ("unloaded" as const),
      activeRequests: residency?.busy ? 1 : 0,
      idleSince: residency && !residency.busy ? (IDLE_SINCE[id] ?? null) : null,
      lastRequestAt: null,
      savedSlotIds: [],
    },
  };
}

function buildPlanRequest(
  requestedTargetId: string,
  world: World,
  coordinator: ComputeDomainCoordinator,
): ApiProxySchedulerPlanRequest {
  return ApiProxySchedulerPlanRequestSchema.parse({
    mode: "request",
    requestedTargetId,
    now: "2026-05-30T10:00:10.000Z",
    pools: [POOL],
    protectedTargetIds: [...coordinator.wantedTargetIds()],
    targets: MODELS.map((id) => planTarget(id, world)),
  });
}

function applyPlan(plan: ApiProxySchedulerPlan, world: World): string[] {
  const displaced: string[] = [];
  for (const action of plan.actions) {
    if (action.type === "unload-model" || action.type === "stop-instance") {
      world.resident.delete(action.targetId);
      displaced.push(action.targetId);
    }
    if (action.type === "load-model") {
      world.resident.set(action.targetId, { busy: true });
    }
  }
  return displaced;
}

async function serveRequest(input: {
  targetId: string;
  world: World;
  coordinator: ComputeDomainCoordinator;
  swap: DomainSwapCoordinator;
  enter?: () => void;
  exit?: () => void;
}): Promise<{ lease: DomainLease; displaced: string[] }> {
  const { targetId, world, coordinator, swap } = input;
  const lease = await coordinator.acquire({
    domains: ["gpu0"],
    targetId,
    priority: 100,
    preemptible: true,
    decide: buildDomainAdmissionDecider({
      candidateTargetId: targetId,
      candidatePriority: 100,
      planRequest: buildPlanRequest(targetId, world, coordinator),
    }),
  });
  const displaced = await swap.run(["gpu0"], async () => {
    input.enter?.();
    try {
      const fresh = planApiProxyRequest(
        buildPlanRequest(targetId, world, coordinator),
        { allowBusyEviction: true },
      );
      assert.equal(
        fresh.ok,
        true,
        `plan for ${targetId} blocked: ${fresh.blockingReason}`,
      );
      await Promise.resolve();
      return applyPlan(fresh, world);
    } finally {
      input.exit?.();
    }
  });
  return { lease, displaced };
}

test("an in-flight model is not evicted to load a third model (arena scenario)", async () => {
  const coordinator = new ComputeDomainCoordinator();
  const swap = new DomainSwapCoordinator();
  const world: World = {
    resident: new Map([
      ["m1", { busy: false }],
      ["m2", { busy: false }],
    ]),
  };

  const battlePartner = await serveRequest({
    targetId: "m2",
    world,
    coordinator,
    swap,
  });
  const challenger = await serveRequest({
    targetId: "m3",
    world,
    coordinator,
    swap,
  });

  assert.deepEqual([...world.resident.keys()].sort(), ["m2", "m3"]);
  assert.deepEqual(challenger.displaced, ["m1"]);
  assert.deepEqual(battlePartner.displaced, []);

  battlePartner.lease.release();
  challenger.lease.release();
});

test("concurrent swaps on one domain serialize and never over-subscribe", async () => {
  const coordinator = new ComputeDomainCoordinator();
  const swap = new DomainSwapCoordinator();
  const world: World = { resident: new Map([["m1", { busy: false }]]) };

  let active = 0;
  let maxActive = 0;
  const enter = () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
  };
  const exit = () => {
    active -= 1;
  };

  const results = await Promise.all([
    serveRequest({ targetId: "m2", world, coordinator, swap, enter, exit }),
    serveRequest({ targetId: "m3", world, coordinator, swap, enter, exit }),
  ]);

  assert.equal(maxActive, 1);
  assert.equal(world.resident.size, 2);
  assert.deepEqual([...world.resident.keys()].sort(), ["m2", "m3"]);

  for (const result of results) {
    result.lease.release();
  }
});
