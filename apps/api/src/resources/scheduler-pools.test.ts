import type { MemoryPool } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSchedulerPoolInputs } from "./ledger.js";

function pool(
  overrides: Partial<MemoryPool> & Pick<MemoryPool, "id">,
): MemoryPool {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    kind: overrides.kind ?? "gpu",
    capacityBytes: overrides.capacityBytes ?? 0,
    reservedBytes: overrides.reservedBytes ?? 0,
    deviceRef: overrides.deviceRef ?? null,
    autoCapacity: overrides.autoCapacity ?? true,
  };
}

const POOLS: MemoryPool[] = [
  pool({ id: "gpu0", kind: "gpu", capacityBytes: 24, reservedBytes: 4 }),
  pool({ id: "host", kind: "host", capacityBytes: 64, reservedBytes: 8 }),
];

test("computeSchedulerPoolInputs reports budget and excludes target instances from usedByOthers", () => {
  const inputs = computeSchedulerPoolInputs(
    POOLS,
    [
      {
        instanceId: "A",
        draws: [
          { poolId: "gpu0", bytes: 10 },
          { poolId: "host", bytes: 5 },
        ],
      },
      { instanceId: "B", draws: [{ poolId: "gpu0", bytes: 6 }] },
    ],
    new Set(["A"]),
  );
  assert.deepEqual(inputs, [
    { poolId: "gpu0", kind: "gpu", budgetBytes: 20, usedByOthersBytes: 6 },
    { poolId: "host", kind: "host", budgetBytes: 56, usedByOthersBytes: 0 },
  ]);
});

test("computeSchedulerPoolInputs counts every resident when none are targets", () => {
  const inputs = computeSchedulerPoolInputs(
    POOLS,
    [
      { instanceId: "A", draws: [{ poolId: "gpu0", bytes: 10 }] },
      { instanceId: "B", draws: [{ poolId: "gpu0", bytes: 6 }] },
    ],
    new Set(),
  );
  assert.equal(
    inputs.find((entry) => entry.poolId === "gpu0")?.usedByOthersBytes,
    16,
  );
});

test("an rpc-worker resident is a fixed usedByOthers baseline, never an eviction target", () => {
  const inputs = computeSchedulerPoolInputs(
    POOLS,
    [
      { instanceId: "orchestrator", draws: [{ poolId: "gpu0", bytes: 8 }] },
      { instanceId: "worker", draws: [{ poolId: "gpu0", bytes: 9 }] },
    ],
    new Set(["orchestrator"]),
  );
  assert.equal(
    inputs.find((entry) => entry.poolId === "gpu0")?.usedByOthersBytes,
    9,
  );
});

test("computeSchedulerPoolInputs clamps an over-reserved pool budget to zero", () => {
  const inputs = computeSchedulerPoolInputs(
    [pool({ id: "gpu0", capacityBytes: 8, reservedBytes: 16 })],
    [],
    new Set(),
  );
  assert.equal(inputs[0]?.budgetBytes, 0);
});
