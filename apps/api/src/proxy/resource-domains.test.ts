import type {
  ApiProxySchedulerPoolInput,
  MemoryPool,
} from "@llama-manager/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeDomains, requestComputeDomains } from "./resource-domains.js";

const POOLS: Pick<MemoryPool, "id" | "kind">[] = [
  { id: "gpu0", kind: "gpu" },
  { id: "gpu1", kind: "gpu" },
  { id: "host", kind: "host" },
];

test("computeDomains returns the single pool a draw touches", () => {
  assert.deepEqual(computeDomains([{ poolId: "gpu0", bytes: 1 }], POOLS), [
    "gpu0",
  ]);
});

test("computeDomains returns sorted domains for a tensor-split draw", () => {
  assert.deepEqual(
    computeDomains(
      [
        { poolId: "gpu1", bytes: 1 },
        { poolId: "gpu0", bytes: 1 },
      ],
      POOLS,
    ),
    ["gpu0", "gpu1"],
  );
});

test("computeDomains yields a host domain alongside a gpu domain (partial offload)", () => {
  assert.deepEqual(
    computeDomains(
      [
        { poolId: "gpu0", bytes: 1 },
        { poolId: "host", bytes: 2 },
      ],
      POOLS,
    ),
    ["gpu0", "host"],
  );
});

test("computeDomains returns the host domain for a host-only draw (CPU compute)", () => {
  assert.deepEqual(computeDomains([{ poolId: "host", bytes: 2 }], POOLS), [
    "host",
  ]);
});

test("computeDomains returns no domains for an empty draw", () => {
  assert.deepEqual(computeDomains([], POOLS), []);
});

test("computeDomains dedupes repeated draws on the same pool", () => {
  assert.deepEqual(
    computeDomains(
      [
        { poolId: "gpu0", bytes: 1 },
        { poolId: "gpu0", bytes: 2 },
      ],
      POOLS,
    ),
    ["gpu0"],
  );
});

test("computeDomains ignores draws referencing unknown pools", () => {
  assert.deepEqual(computeDomains([{ poolId: "gpu9", bytes: 1 }], POOLS), []);
});

const POOL_INPUTS: Pick<ApiProxySchedulerPoolInput, "poolId" | "kind">[] = [
  { poolId: "gpu0", kind: "gpu" },
  { poolId: "gpu1", kind: "gpu" },
  { poolId: "host", kind: "host" },
];

test("requestComputeDomains derives sorted gpu and host domains from scheduler pool inputs", () => {
  assert.deepEqual(
    requestComputeDomains(
      [
        { poolId: "gpu1", bytes: 1 },
        { poolId: "gpu0", bytes: 1 },
        { poolId: "host", bytes: 1 },
      ],
      POOL_INPUTS,
    ),
    ["gpu0", "gpu1", "host"],
  );
});

test("requestComputeDomains returns the host domain for a host-only draw", () => {
  assert.deepEqual(
    requestComputeDomains([{ poolId: "host", bytes: 1 }], POOL_INPUTS),
    ["host"],
  );
});
