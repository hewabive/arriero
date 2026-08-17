import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { getSystemResources } from "../system/resources.js";
import {
  RESOURCES_FILE,
  deleteMemoryPool,
  ensureResourcePoolsScaffold,
  getMemoryPool,
  listMemoryPools,
  listMemoryPoolsWithStatus,
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

test("refreshAutoCapacities persists a GPU detected after the scaffold was created", () => {
  const initial = getSystemResources();
  ensureResourcePoolsScaffold({ ...initial, accelerators: [] });
  assert.equal(
    listMemoryPools().some((pool) => pool.kind === "gpu"),
    false,
  );
  const detectedGpu = {
    id: "7",
    name: "Late NVIDIA GPU",
    vendor: "NVIDIA" as const,
    kind: "gpu" as const,
    totalMemoryBytes: 24_000,
    availableMemoryBytes: 23_000,
    memoryUsedRatio: 1 / 24,
    utilizationPercent: 0,
    temperatureC: null,
    numaNode: 0,
    computeCapability: null,
    source: "nvml" as const,
  };
  assert.equal(
    refreshAutoCapacities({
      ...initial,
      accelerators: [detectedGpu],
    }),
    true,
  );
  assert.deepEqual(
    listMemoryPools()
      .filter((pool) => pool.kind === "gpu")
      .map((pool) => ({
        id: pool.id,
        deviceRef: pool.deviceRef,
        capacityBytes: pool.capacityBytes,
      })),
    [{ id: "gpu7", deviceRef: "7", capacityBytes: 24_000 }],
  );
  const stored = JSON.parse(readFileSync(RESOURCES_FILE, "utf8")) as Array<{
    id: string;
    deviceRef: string | null;
    capacityBytes: number;
  }>;
  assert.deepEqual(
    stored
      .filter((pool) => pool.id === "gpu7")
      .map((pool) => ({
        id: pool.id,
        deviceRef: pool.deviceRef,
        capacityBytes: pool.capacityBytes,
      })),
    [{ id: "gpu7", deviceRef: "7", capacityBytes: 24_000 }],
  );

  resetResourcePoolsCache();
  assert.equal(getMemoryPool("gpu7")?.deviceRef, "7");
});

function scaffoldWithGpu(deviceRef: string) {
  const initial = getSystemResources();
  ensureResourcePoolsScaffold({
    ...initial,
    accelerators: [
      {
        id: deviceRef,
        name: "Test NVIDIA GPU",
        vendor: "NVIDIA" as const,
        kind: "gpu" as const,
        totalMemoryBytes: 24_000,
        availableMemoryBytes: 23_000,
        memoryUsedRatio: 1 / 24,
        utilizationPercent: 0,
        temperatureC: null,
        numaNode: 0,
        computeCapability: null,
        source: "nvml" as const,
      },
    ],
  });
}

test("listMemoryPoolsWithStatus flags a gpu pool whose device is gone", () => {
  scaffoldWithGpu("0");
  const pools = listMemoryPoolsWithStatus({
    authoritative: true,
    deviceRefs: new Set(),
  });
  assert.equal(pools.find((pool) => pool.id === "gpu0")?.orphaned, true);
  assert.equal(pools.find((pool) => pool.id === "host")?.orphaned, false);
});

test("listMemoryPoolsWithStatus keeps pools intact when the device is present", () => {
  scaffoldWithGpu("0");
  const pools = listMemoryPoolsWithStatus({
    authoritative: true,
    deviceRefs: new Set(["0"]),
  });
  assert.equal(
    pools.every((pool) => pool.orphaned === false),
    true,
  );
});

test("listMemoryPoolsWithStatus never flags pools without an authoritative inventory", () => {
  scaffoldWithGpu("0");
  const pools = listMemoryPoolsWithStatus({
    authoritative: false,
    deviceRefs: new Set(),
  });
  assert.equal(
    pools.every((pool) => pool.orphaned === false),
    true,
  );
});

test("deleteMemoryPool removes the pool and persists the file", () => {
  scaffoldWithGpu("0");
  assert.equal(deleteMemoryPool("gpu0"), true);
  assert.equal(getMemoryPool("gpu0"), null);
  resetResourcePoolsCache();
  assert.equal(getMemoryPool("gpu0"), null);
  assert.ok(getMemoryPool("host"));
});

test("deleteMemoryPool returns false for an unknown pool", () => {
  ensureResourcePoolsScaffold();
  assert.equal(deleteMemoryPool("nope"), false);
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
