import {
  ApiProxySchedulerPlanRequestSchema,
  type ApiProxySchedulerPlanRequest,
} from "@llama-manager/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDomainAdmissionDecider,
  parseInstanceConcurrencyLimit,
  parseInstanceParallelLimit,
} from "./domain-admission.js";
import type { DomainHolderView } from "./domain-coordinator.js";

test("parseInstanceParallelLimit reads --parallel/-np and rejects invalid values", () => {
  assert.equal(parseInstanceParallelLimit({ "--parallel": 4 }), 4);
  assert.equal(parseInstanceParallelLimit({ "--parallel": "8" }), 8);
  assert.equal(parseInstanceParallelLimit({ "-np": 2 }), 2);
  assert.equal(parseInstanceParallelLimit({}), undefined);
  assert.equal(parseInstanceParallelLimit({ "--parallel": 0 }), undefined);
  assert.equal(parseInstanceParallelLimit({ "--parallel": "nope" }), undefined);
});

test("parseInstanceConcurrencyLimit follows the engine descriptor", () => {
  assert.equal(
    parseInstanceConcurrencyLimit({
      kind: "llama-server",
      args: { "--parallel": 4 },
    }),
    4,
  );
  assert.equal(
    parseInstanceConcurrencyLimit({
      kind: "vllm",
      args: { "--max-num-seqs": "12", "--parallel": 99 },
    }),
    12,
  );
  assert.equal(
    parseInstanceConcurrencyLimit({
      kind: "ktransformers",
      args: { "--max-running-requests": 7, "--parallel": 99 },
    }),
    7,
  );
  assert.equal(
    parseInstanceConcurrencyLimit({ kind: "rpc-worker", args: {} }),
    undefined,
  );
});

function target(input: {
  id: string;
  instanceId: string;
  priority: number;
  state: "unloaded" | "ready";
  bytes: number;
  preemptible?: boolean;
  activeRequests?: number;
}) {
  return {
    id: input.id,
    name: input.id,
    endpointId: `instance:${input.instanceId}`,
    instanceId: input.instanceId,
    model: input.id,
    role: "interactive" as const,
    priority: input.priority,
    preemptible: input.preemptible ?? true,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
    draws: [{ poolId: "gpu0", bytes: input.bytes }],
    runtime: {
      targetId: input.id,
      kind: "managed-instance",
      endpointId: `instance:${input.instanceId}`,
      baseUrl: `http://127.0.0.1/${input.id}/v1`,
      instanceId: input.instanceId,
      model: input.id,
      state: input.state,
      activeRequests: input.activeRequests ?? 0,
      idleSince: null,
      lastRequestAt: null,
      savedSlotIds: [],
    },
  };
}

function planRequest(input: {
  requestedTargetId: string;
  usedByOthersBytes?: number;
  targets: ReturnType<typeof target>[];
}): ApiProxySchedulerPlanRequest {
  return ApiProxySchedulerPlanRequestSchema.parse({
    mode: "request",
    requestedTargetId: input.requestedTargetId,
    now: "2026-05-30T10:00:00.000Z",
    pools: [
      {
        poolId: "gpu0",
        kind: "gpu",
        budgetBytes: 100,
        usedByOthersBytes: input.usedByOthersBytes ?? 0,
      },
    ],
    targets: input.targets,
  });
}

function holder(input: {
  targetId: string;
  priority: number;
  running: boolean;
  preemptible?: boolean;
}): DomainHolderView {
  return {
    leaseId: `lease-${input.targetId}`,
    targetId: input.targetId,
    priority: input.priority,
    preemptible: input.preemptible ?? true,
    running: input.running,
  };
}

test("admits when the candidate fits with no holders", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "i",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
      ],
    }),
  });

  assert.deepEqual(decide({ domains: ["gpu0"], holders: [] }), {
    type: "admit",
  });
});

test("holds behind a strictly-higher-priority running holder", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "ic",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
        target({
          id: "peer",
          instanceId: "ip",
          priority: 500,
          state: "ready",
          activeRequests: 1,
          bytes: 50,
        }),
      ],
    }),
  });

  assert.deepEqual(
    decide({
      domains: ["gpu0"],
      holders: [holder({ targetId: "peer", priority: 500, running: true })],
    }),
    { type: "wait" },
  );
});

test("preempts a busy lower-priority holder that blocks the fit", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "ic",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
        target({
          id: "peer",
          instanceId: "ip",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          bytes: 70,
        }),
      ],
    }),
  });

  assert.deepEqual(
    decide({
      domains: ["gpu0"],
      holders: [holder({ targetId: "peer", priority: 10, running: true })],
    }),
    { type: "preempt", leaseIds: ["lease-peer"] },
  );
});

test("admits once the preempted holder is suspended (memory freed)", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "ic",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
        target({
          id: "peer",
          instanceId: "ip",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          bytes: 70,
        }),
      ],
    }),
  });

  assert.deepEqual(
    decide({
      domains: ["gpu0"],
      holders: [holder({ targetId: "peer", priority: 10, running: false })],
    }),
    { type: "admit" },
  );
});

test("waits when immovable usage leaves no room", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      usedByOthersBytes: 80,
      targets: [
        target({
          id: "cand",
          instanceId: "ic",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
      ],
    }),
  });

  assert.deepEqual(decide({ domains: ["gpu0"], holders: [] }), {
    type: "wait",
  });
});

test("waits when the busy obstacle is not a holder this coordinator controls", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "ic",
          priority: 100,
          state: "unloaded",
          bytes: 50,
        }),
        target({
          id: "peer",
          instanceId: "ip",
          priority: 10,
          state: "ready",
          activeRequests: 1,
          bytes: 70,
        }),
      ],
    }),
  });

  assert.deepEqual(decide({ domains: ["gpu0"], holders: [] }), {
    type: "wait",
  });
});

test("waits when the candidate is at its --parallel concurrency cap", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    parallelLimit: 1,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "i",
          priority: 100,
          state: "ready",
          bytes: 50,
        }),
      ],
    }),
  });

  assert.deepEqual(
    decide({
      domains: ["gpu0"],
      holders: [holder({ targetId: "cand", priority: 100, running: true })],
    }),
    { type: "wait" },
  );
});

test("admits a same-target request below the --parallel concurrency cap", () => {
  const decide = buildDomainAdmissionDecider({
    candidateTargetId: "cand",
    candidatePriority: 100,
    parallelLimit: 2,
    planRequest: planRequest({
      requestedTargetId: "cand",
      targets: [
        target({
          id: "cand",
          instanceId: "i",
          priority: 100,
          state: "ready",
          bytes: 50,
        }),
      ],
    }),
  });

  assert.deepEqual(
    decide({
      domains: ["gpu0"],
      holders: [holder({ targetId: "cand", priority: 100, running: true })],
    }),
    { type: "admit" },
  );
});
