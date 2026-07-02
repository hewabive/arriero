import { ApiProxySchedulerPlanRequestSchema } from "@llama-manager/core";
import assert from "node:assert/strict";
import test from "node:test";

import {
  planApiProxyIdleMaintenance,
  planApiProxyRequest,
} from "./scheduler.js";

function planRequest(input: unknown) {
  return ApiProxySchedulerPlanRequestSchema.parse(input);
}

function target(input: {
  id: string;
  name: string;
  instanceId: string;
  model: string;
  priority: number;
  state: "unknown" | "stopped" | "unloaded" | "loading" | "ready" | "error";
  role?: "interactive" | "background";
  preemptible?: boolean;
  activeRequests?: number;
  idleSince?: string | null;
  idleUnloadMs?: number | null;
  saveSlotsBeforeUnload?: boolean;
  slotIds?: number[];
  savedSlotIds?: number[];
  draws?: { poolId: string; bytes: number }[];
}) {
  return {
    id: input.id,
    name: input.name,
    endpointId: `instance:${input.instanceId}`,
    instanceId: input.instanceId,
    model: input.model,
    role: input.role ?? "interactive",
    priority: input.priority,
    preemptible: input.preemptible ?? true,
    saveSlotsBeforeUnload: input.saveSlotsBeforeUnload ?? false,
    slotIds: input.slotIds ?? [],
    idleUnloadMs: input.idleUnloadMs ?? null,
    draws: input.draws ?? [],
    runtime: {
      targetId: input.id,
      kind: "managed-instance",
      endpointId: `instance:${input.instanceId}`,
      baseUrl: `http://127.0.0.1/${input.id}/v1`,
      instanceId: input.instanceId,
      model: input.model,
      state: input.state,
      activeRequests: input.activeRequests ?? 0,
      idleSince: input.idleSince ?? null,
      lastRequestAt: null,
      savedSlotIds: input.savedSlotIds ?? [],
    },
  };
}

test("planApiProxyRequest preempts lower-priority target and saves slots", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "background",
          name: "Background batch",
          instanceId: "inst-bg",
          model: "slow",
          priority: 10,
          role: "background",
          state: "ready",
          activeRequests: 1,
          saveSlotsBeforeUnload: true,
          slotIds: [0],
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
    { allowBusyEviction: true },
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    [
      "save-slot",
      "unload-model",
      "load-model",
      "wait-model-ready",
      "route-request",
    ],
  );
  assert.equal(plan.actions[0]?.targetId, "background");
  assert.equal(plan.actions[0]?.slotId, 0);
  assert.equal(plan.actions.at(-1)?.targetId, "urgent");
});

test("planApiProxyRequest does not re-emit save-slot for already-saved slots", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "background",
          name: "Background batch",
          instanceId: "inst-bg",
          model: "slow",
          priority: 10,
          role: "background",
          state: "ready",
          activeRequests: 1,
          saveSlotsBeforeUnload: true,
          slotIds: [0],
          savedSlotIds: [0],
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
    { allowBusyEviction: true },
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["unload-model", "load-model", "wait-model-ready", "route-request"],
  );
});

test("planApiProxyRequest routes external API targets without instance actions", () => {
  const externalTarget = target({
    id: "external",
    name: "External API",
    instanceId: "ignored",
    model: "upstream-model",
    priority: 100,
    state: "ready",
  });
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "external",
      now: "2026-05-30T10:00:00.000Z",
      targets: [
        {
          ...externalTarget,
          instanceId: null,
          runtime: {
            ...externalTarget.runtime,
            kind: "external-api",
            instanceId: null,
          },
        },
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["route-request"],
  );
  assert.equal(plan.actions[0]?.instanceId, null);
});

test("planApiProxyRequest blocks on non-preemptible busy peer", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "background",
          name: "Background batch",
          instanceId: "inst-bg",
          model: "slow",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          preemptible: false,
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
    { allowBusyEviction: true },
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /does not fit/);
  assert.deepEqual(plan.actions, []);
});

test("planApiProxyRequest blocks targets in error state", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      targets: [
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "error",
        }),
      ],
    }),
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /error state/);
  assert.deepEqual(plan.actions, []);
});

test("planApiProxyIdleMaintenance unloads idle urgent target and resumes background target", () => {
  const plan = planApiProxyIdleMaintenance(
    planRequest({
      mode: "idle",
      preferredTargetId: "background",
      now: "2026-05-30T10:00:12.000Z",
      targets: [
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "ready",
          idleSince: "2026-05-30T10:00:00.000Z",
          idleUnloadMs: 10_000,
        }),
        target({
          id: "background",
          name: "Background batch",
          instanceId: "inst-bg",
          model: "slow",
          priority: 10,
          role: "background",
          state: "unloaded",
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["unload-model", "load-model", "wait-model-ready"],
  );
  assert.equal(plan.actions[0]?.targetId, "urgent");
  assert.equal(plan.actions[1]?.targetId, "background");
});

test("planApiProxyRequest leaves a fitting resident peer alone (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "new",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "resident",
          name: "Resident",
          instanceId: "inst-resident",
          model: "a",
          priority: 50,
          state: "ready",
          draws: [{ poolId: "gpu0", bytes: 40 }],
        }),
        target({
          id: "new",
          name: "New chat",
          instanceId: "inst-new",
          model: "b",
          priority: 50,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 40 }],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["load-model", "wait-model-ready", "route-request"],
  );
});

test("planApiProxyRequest evicts an idle lower-priority peer to fit (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "batch",
          name: "Batch",
          instanceId: "inst-batch",
          model: "slow",
          priority: 10,
          state: "ready",
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["unload-model", "load-model", "wait-model-ready", "route-request"],
  );
  assert.equal(plan.actions[0]?.targetId, "batch");
});

test("planApiProxyRequest queues when only a busy peer blocks the fit (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "batch",
          name: "Batch",
          instanceId: "inst-batch",
          model: "slow",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /does not fit/);
  assert.deepEqual(plan.actions, []);
});

test("planApiProxyRequest never evicts a higher-priority idle peer (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "batch",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "chat",
          name: "Resident chat",
          instanceId: "inst-chat",
          model: "chat",
          priority: 200,
          state: "ready",
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "batch",
          name: "Batch",
          instanceId: "inst-batch",
          model: "slow",
          priority: 10,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /does not fit/);
  assert.deepEqual(plan.actions, []);
});

test("planApiProxyRequest evicts across split pools (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
        { poolId: "gpu1", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "batch",
          name: "Batch",
          instanceId: "inst-batch",
          model: "slow",
          priority: 10,
          state: "ready",
          draws: [
            { poolId: "gpu0", bytes: 60 },
            { poolId: "gpu1", bytes: 60 },
          ],
        }),
        target({
          id: "urgent",
          name: "Urgent split",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [
            { poolId: "gpu0", bytes: 60 },
            { poolId: "gpu1", bytes: 60 },
          ],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["unload-model", "load-model", "wait-model-ready", "route-request"],
  );
  assert.equal(plan.actions[0]?.targetId, "batch");
});

test("planApiProxyRequest queues when immovable usage leaves no room (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        {
          poolId: "gpu0",
          kind: "gpu",
          budgetBytes: 100,
          usedByOthersBytes: 80,
        },
      ],
      targets: [
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /does not fit/);
  assert.deepEqual(plan.actions, []);
});

test("planApiProxyRequest preempts a busy lower-priority peer when allowed (memory)", () => {
  const request = planRequest({
    mode: "request",
    requestedTargetId: "urgent",
    now: "2026-05-30T10:00:00.000Z",
    pools: [
      { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
    ],
    targets: [
      target({
        id: "batch",
        name: "Batch",
        instanceId: "inst-batch",
        model: "slow",
        priority: 10,
        state: "ready",
        activeRequests: 1,
        draws: [{ poolId: "gpu0", bytes: 70 }],
      }),
      target({
        id: "urgent",
        name: "Urgent chat",
        instanceId: "inst-urgent",
        model: "chat",
        priority: 100,
        state: "unloaded",
        draws: [{ poolId: "gpu0", bytes: 50 }],
      }),
    ],
  });

  const blockedPlan = planApiProxyRequest(request);
  assert.equal(blockedPlan.ok, false);
  assert.deepEqual(blockedPlan.preemptTargetIds, []);

  const plan = planApiProxyRequest(request, { allowBusyEviction: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.preemptTargetIds, ["batch"]);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["unload-model", "load-model", "wait-model-ready", "route-request"],
  );
  assert.equal(plan.actions[0]?.targetId, "batch");
});

test("planApiProxyRequest prefers an idle victim over a busy one (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "idle-batch",
          name: "Idle batch",
          instanceId: "inst-idle",
          model: "slow",
          priority: 10,
          state: "ready",
          draws: [{ poolId: "gpu0", bytes: 40 }],
        }),
        target({
          id: "busy-batch",
          name: "Busy batch",
          instanceId: "inst-busy",
          model: "slow2",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          draws: [{ poolId: "gpu0", bytes: 40 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
    { allowBusyEviction: true },
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.preemptTargetIds, []);
  assert.equal(plan.actions[0]?.targetId, "idle-batch");
});

test("planApiProxyRequest never preempts an equal-priority busy peer (memory)", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "urgent",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "peer",
          name: "Peer",
          instanceId: "inst-peer",
          model: "slow",
          priority: 100,
          state: "ready",
          activeRequests: 1,
          draws: [{ poolId: "gpu0", bytes: 70 }],
        }),
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "unloaded",
          draws: [{ poolId: "gpu0", bytes: 50 }],
        }),
      ],
    }),
    { allowBusyEviction: true },
  );

  assert.equal(plan.ok, false);
  assert.match(plan.blockingReason ?? "", /does not fit/);
});

test("planApiProxyRequest skips the memory axis when no draws are declared", () => {
  const plan = planApiProxyRequest(
    planRequest({
      mode: "request",
      requestedTargetId: "new",
      now: "2026-05-30T10:00:00.000Z",
      pools: [
        { poolId: "gpu0", kind: "gpu", budgetBytes: 1, usedByOthersBytes: 0 },
      ],
      targets: [
        target({
          id: "resident",
          name: "Resident",
          instanceId: "inst-resident",
          model: "a",
          priority: 50,
          state: "ready",
          draws: [{ poolId: "gpu0", bytes: 999 }],
        }),
        target({
          id: "new",
          name: "Undeclared",
          instanceId: "inst-new",
          model: "b",
          priority: 50,
          state: "unloaded",
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions.map((item) => item.type),
    ["load-model", "wait-model-ready", "route-request"],
  );
});

function threeWayContention(protectedTargetIds?: string[]) {
  return planRequest({
    mode: "request",
    requestedTargetId: "m3",
    now: "2026-05-30T10:00:10.000Z",
    pools: [
      { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
    ],
    ...(protectedTargetIds ? { protectedTargetIds } : {}),
    targets: [
      target({
        id: "m1",
        name: "Model one",
        instanceId: "inst-1",
        model: "one",
        priority: 50,
        state: "ready",
        idleSince: "2026-05-30T10:00:05.000Z",
        draws: [{ poolId: "gpu0", bytes: 40 }],
      }),
      target({
        id: "m2",
        name: "Model two",
        instanceId: "inst-2",
        model: "two",
        priority: 50,
        state: "ready",
        idleSince: "2026-05-30T10:00:00.000Z",
        draws: [{ poolId: "gpu0", bytes: 40 }],
      }),
      target({
        id: "m3",
        name: "Model three",
        instanceId: "inst-3",
        model: "three",
        priority: 50,
        state: "unloaded",
        draws: [{ poolId: "gpu0", bytes: 40 }],
      }),
    ],
  });
}

test("planApiProxyRequest without demand signal can evict a still-wanted idle peer", () => {
  const plan = planApiProxyRequest(threeWayContention(), {
    allowBusyEviction: true,
  });

  assert.equal(plan.ok, true);
  const unload = plan.actions.find((item) => item.type === "unload-model");
  assert.equal(unload?.targetId, "m2");
});

test("planApiProxyRequest spares a wanted peer and evicts the unwanted idle one", () => {
  const plan = planApiProxyRequest(threeWayContention(["m2"]), {
    allowBusyEviction: true,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.actions
      .filter((item) => item.type === "unload-model")
      .map((item) => item.targetId),
    ["m1"],
  );
});

test("planApiProxyRequest evicts a wanted peer only when every peer is wanted", () => {
  const plan = planApiProxyRequest(threeWayContention(["m1", "m2"]), {
    allowBusyEviction: true,
  });

  assert.equal(plan.ok, true);
  assert.equal(
    plan.actions.filter((item) => item.type === "unload-model").length,
    1,
  );
});

test("planApiProxyRequest never evicts a pinned peer even when it is the only victim", () => {
  const request = planRequest({
    mode: "request",
    requestedTargetId: "new",
    now: "2026-05-30T10:00:10.000Z",
    pools: [
      { poolId: "gpu0", kind: "gpu", budgetBytes: 100, usedByOthersBytes: 0 },
    ],
    pinnedTargetIds: ["resident"],
    targets: [
      target({
        id: "resident",
        name: "Resident",
        instanceId: "inst-resident",
        model: "a",
        priority: 10,
        state: "ready",
        idleSince: "2026-05-30T10:00:00.000Z",
        draws: [{ poolId: "gpu0", bytes: 80 }],
      }),
      target({
        id: "new",
        name: "New chat",
        instanceId: "inst-new",
        model: "b",
        priority: 100,
        state: "unloaded",
        draws: [{ poolId: "gpu0", bytes: 80 }],
      }),
    ],
  });

  const plan = planApiProxyRequest(request, { allowBusyEviction: true });
  assert.equal(plan.ok, false);
  assert.equal(
    plan.actions.filter((item) => item.type === "unload-model").length,
    0,
  );
});

test("planApiProxyIdleMaintenance skips pinned targets past their idle threshold", () => {
  const plan = planApiProxyIdleMaintenance(
    planRequest({
      mode: "idle",
      now: "2026-05-30T10:00:12.000Z",
      pinnedTargetIds: ["urgent"],
      targets: [
        target({
          id: "urgent",
          name: "Urgent chat",
          instanceId: "inst-urgent",
          model: "chat",
          priority: 100,
          state: "ready",
          idleSince: "2026-05-30T10:00:00.000Z",
          idleUnloadMs: 10_000,
        }),
      ],
    }),
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions, []);
});
