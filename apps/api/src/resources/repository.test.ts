import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { getSystemResources } from "../system/resources.js";
import {
  RESOURCES_FILE,
  ensureResourcePoolsScaffold,
  getMemoryPool,
  listMemoryPools,
  refreshAutoCapacities,
  resetResourcePoolsCache,
  updateMemoryPool,
} from "./repository.js";

beforeEach(() => {
  resetResourcePoolsCache();
  rmSync(RESOURCES_FILE, { force: true });
});

test("scaffold seeds a host pool and is idempotent once the file exists", () => {
  assert.equal(ensureResourcePoolsScaffold(), true);
  const host = getMemoryPool("host");
  assert.ok(host, "expected a host pool to be seeded");
  assert.equal(host?.kind, "host");
  assert.ok(host && host.capacityBytes > 0);
  assert.equal(ensureResourcePoolsScaffold(), false);
});

test("updateMemoryPool changes the reserve and leaves other fields intact", () => {
  ensureResourcePoolsScaffold();
  const before = getMemoryPool("host");
  const updated = updateMemoryPool("host", { reservedBytes: 1234567 });
  assert.equal(updated?.reservedBytes, 1234567);
  assert.equal(updated?.capacityBytes, before?.capacityBytes);
  assert.equal(getMemoryPool("host")?.reservedBytes, 1234567);
});

test("updateMemoryPool returns null for an unknown pool", () => {
  ensureResourcePoolsScaffold();
  assert.equal(updateMemoryPool("nope", { reservedBytes: 1 }), null);
});

test("refreshAutoCapacities only retargets pools with autoCapacity enabled", () => {
  ensureResourcePoolsScaffold();
  const detectedTotal = getSystemResources().memory.totalBytes;

  updateMemoryPool("host", { capacityBytes: 1 });
  const storedBeforeRefresh = readFileSync(RESOURCES_FILE, "utf8");
  assert.equal(refreshAutoCapacities(), true);
  assert.equal(getMemoryPool("host")?.capacityBytes, detectedTotal);
  assert.equal(readFileSync(RESOURCES_FILE, "utf8"), storedBeforeRefresh);

  updateMemoryPool("host", { capacityBytes: 1, autoCapacity: false });
  assert.equal(refreshAutoCapacities(), false);
  assert.equal(getMemoryPool("host")?.capacityBytes, 1);
});

test("listMemoryPools returns gpu pools before the host pool", () => {
  ensureResourcePoolsScaffold();
  const pools = listMemoryPools();
  assert.ok(pools.some((pool) => pool.id === "host"));
  const lastGpu = pools.map((pool) => pool.kind).lastIndexOf("gpu");
  const firstHost = pools.findIndex((pool) => pool.kind === "host");
  if (lastGpu >= 0) {
    assert.ok(lastGpu < firstHost);
  }
});
