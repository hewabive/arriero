import {
  buildResourceLedger,
  checkDrawAdmission,
  type MemoryPool,
} from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

const GIB = 1024 ** 3;

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
  pool({ id: "gpu0", kind: "gpu", capacityBytes: 24 * GIB }),
  pool({
    id: "host",
    kind: "host",
    capacityBytes: 64 * GIB,
    reservedBytes: 8 * GIB,
  }),
];

test("buildResourceLedger sums draws and computes budget/available per pool", () => {
  const ledger = buildResourceLedger(POOLS, [
    {
      instanceId: "a",
      draws: [
        { poolId: "gpu0", bytes: 18 * GIB },
        { poolId: "host", bytes: 4 * GIB },
      ],
    },
  ]);
  const gpu0 = ledger.pools.find((p) => p.poolId === "gpu0");
  const host = ledger.pools.find((p) => p.poolId === "host");
  assert.deepEqual(
    {
      budget: gpu0?.budgetBytes,
      used: gpu0?.usedBytes,
      available: gpu0?.availableBytes,
    },
    { budget: 24 * GIB, used: 18 * GIB, available: 6 * GIB },
  );
  assert.deepEqual(
    {
      budget: host?.budgetBytes,
      used: host?.usedBytes,
      available: host?.availableBytes,
    },
    { budget: 56 * GIB, used: 4 * GIB, available: 52 * GIB },
  );
});

test("buildResourceLedger aggregates multiple residents drawing the same pool", () => {
  const ledger = buildResourceLedger(POOLS, [
    { instanceId: "a", draws: [{ poolId: "gpu0", bytes: 10 * GIB }] },
    { instanceId: "b", draws: [{ poolId: "gpu0", bytes: 8 * GIB }] },
  ]);
  const gpu0 = ledger.pools.find((p) => p.poolId === "gpu0");
  assert.equal(gpu0?.usedBytes, 18 * GIB);
  assert.equal(gpu0?.availableBytes, 6 * GIB);
});

test("buildResourceLedger clamps over-reserved pools to zero budget", () => {
  const ledger = buildResourceLedger(
    [pool({ id: "gpu0", capacityBytes: 8 * GIB, reservedBytes: 16 * GIB })],
    [],
  );
  const gpu0 = ledger.pools[0];
  assert.equal(gpu0?.budgetBytes, 0);
  assert.equal(gpu0?.availableBytes, 0);
});

test("checkDrawAdmission accepts a draw that fits the available budget", () => {
  const ledger = buildResourceLedger(POOLS, [
    { instanceId: "a", draws: [{ poolId: "gpu0", bytes: 18 * GIB }] },
  ]);
  const admission = checkDrawAdmission(ledger, [
    { poolId: "gpu0", bytes: 6 * GIB },
  ]);
  assert.equal(admission.ok, true);
  assert.equal(admission.shortfalls.length, 0);
});

test("checkDrawAdmission reports a deficit when a draw exceeds availability", () => {
  const ledger = buildResourceLedger(POOLS, [
    { instanceId: "a", draws: [{ poolId: "gpu0", bytes: 18 * GIB }] },
  ]);
  const admission = checkDrawAdmission(ledger, [
    { poolId: "gpu0", bytes: 7 * GIB },
  ]);
  assert.equal(admission.ok, false);
  assert.deepEqual(admission.shortfalls, [
    {
      poolId: "gpu0",
      requestedBytes: 7 * GIB,
      availableBytes: 6 * GIB,
      deficitBytes: 1 * GIB,
    },
  ]);
});

test("checkDrawAdmission treats an unknown pool as a full deficit", () => {
  const ledger = buildResourceLedger(POOLS, []);
  const admission = checkDrawAdmission(ledger, [
    { poolId: "gpu9", bytes: 2 * GIB },
  ]);
  assert.equal(admission.ok, false);
  assert.deepEqual(admission.shortfalls, [
    {
      poolId: "gpu9",
      requestedBytes: 2 * GIB,
      availableBytes: 0,
      deficitBytes: 2 * GIB,
    },
  ]);
});

test("checkDrawAdmission aggregates duplicate draws against the same pool", () => {
  const ledger = buildResourceLedger(POOLS, []);
  const admission = checkDrawAdmission(ledger, [
    { poolId: "gpu0", bytes: 20 * GIB },
    { poolId: "gpu0", bytes: 8 * GIB },
  ]);
  assert.equal(admission.ok, false);
  assert.equal(admission.shortfalls[0]?.requestedBytes, 28 * GIB);
});
