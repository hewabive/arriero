import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { getSystemResources } from "../system/resources.js";
import {
  RESOURCES_FILE,
  declareGpuPool,
  deleteMemoryPool,
  ensureResourcePoolsScaffold,
  getMemoryPool,
  listDeclaredMemoryPools,
  listMemoryPools,
  listMemoryPoolsWithStatus,
  listUndeclaredAccelerators,
  resetResourcePoolsCache,
  updateMemoryPool,
} from "./repository.js";

beforeEach(() => {
  resetResourcePoolsCache();
  rmSync(RESOURCES_FILE, { force: true });
});

function testGpu(deviceRef: string) {
  return {
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
  };
}

function scaffoldWithGpu(deviceRef: string) {
  const initial = getSystemResources();
  ensureResourcePoolsScaffold({
    ...initial,
    accelerators: [testGpu(deviceRef)],
  });
}

test("scaffold declares pools with derived capacity and is idempotent", () => {
  assert.equal(ensureResourcePoolsScaffold(), true);
  const declaration = getMemoryPool("host");
  assert.ok(declaration, "expected a host pool to be declared");
  assert.equal(declaration?.kind, "host");
  assert.equal(declaration?.capacityBytes, null);
  assert.equal(
    readFileSync(RESOURCES_FILE, "utf8").includes('"createdAt"'),
    false,
  );
  const effective = listMemoryPools().find((pool) => pool.id === "host");
  assert.equal(
    effective?.capacityBytes,
    getSystemResources().memory.totalBytes,
  );
  assert.equal(ensureResourcePoolsScaffold(), false);
});

test("updateMemoryPool changes the reserve and keeps auto capacity derived", () => {
  ensureResourcePoolsScaffold();
  const updated = updateMemoryPool("host", { reservedBytes: 1234567 });
  assert.equal(updated?.reservedBytes, 1234567);
  assert.equal(updated?.capacityBytes, null);
  assert.equal(getMemoryPool("host")?.reservedBytes, 1234567);
});

test("updateMemoryPool switches to manual capacity and back", () => {
  ensureResourcePoolsScaffold();
  const manual = updateMemoryPool("host", {
    autoCapacity: false,
    capacityBytes: 4_000_000,
  });
  assert.equal(manual?.capacityBytes, 4_000_000);
  assert.equal(
    listMemoryPools().find((pool) => pool.id === "host")?.capacityBytes,
    4_000_000,
  );
  const auto = updateMemoryPool("host", { autoCapacity: true });
  assert.equal(auto?.capacityBytes, null);
  assert.equal(
    listMemoryPools().find((pool) => pool.id === "host")?.capacityBytes,
    getSystemResources().memory.totalBytes,
  );
});

test("updateMemoryPool returns null for an unknown pool", () => {
  ensureResourcePoolsScaffold();
  assert.equal(updateMemoryPool("nope", { reservedBytes: 1 }), null);
});

test("legacy auto pools with stored capacities normalize to null on read", () => {
  ensureResourcePoolsScaffold();
  const raw = JSON.parse(readFileSync(RESOURCES_FILE, "utf8")) as Record<
    string,
    unknown
  >[];
  const withLegacy = raw.map((pool) =>
    pool.id === "host" ? { ...pool, capacityBytes: 12345 } : pool,
  );
  writeFileSync(
    RESOURCES_FILE,
    `${JSON.stringify(withLegacy, null, 2)}\n`,
    "utf8",
  );
  resetResourcePoolsCache();
  assert.equal(getMemoryPool("host")?.capacityBytes, null);
  assert.equal(
    listMemoryPools().find((pool) => pool.id === "host")?.capacityBytes,
    getSystemResources().memory.totalBytes,
  );
});

test("a gpu pool without its device resolves to zero capacity", () => {
  scaffoldWithGpu("7");
  const effective = listMemoryPools().find((pool) => pool.id === "gpu7");
  assert.equal(effective?.capacityBytes, 0);
});

test("declareGpuPool adopts only a detected device and is idempotent", () => {
  ensureResourcePoolsScaffold();
  assert.equal(declareGpuPool("42"), null);
  assert.equal(
    listDeclaredMemoryPools().some((pool) => pool.kind === "gpu"),
    getSystemResources().accelerators.some((item) => item.kind === "gpu"),
  );
});

test("listUndeclaredAccelerators reports detected gpus without declarations", () => {
  const initial = getSystemResources();
  ensureResourcePoolsScaffold({ ...initial, accelerators: [] });
  const undeclared = listUndeclaredAccelerators({
    ...initial,
    accelerators: [testGpu("7")],
  });
  assert.deepEqual(
    undeclared.map((item) => item.id),
    ["7"],
  );
  scaffoldWithGpu("7");
  rmSync(RESOURCES_FILE, { force: true });
  resetResourcePoolsCache();
  ensureResourcePoolsScaffold({ ...initial, accelerators: [testGpu("7")] });
  assert.deepEqual(
    listUndeclaredAccelerators({ ...initial, accelerators: [testGpu("7")] }),
    [],
  );
});

test("listMemoryPoolsWithStatus flags a gpu pool whose device is gone", () => {
  scaffoldWithGpu("0");
  const pools = listMemoryPoolsWithStatus({
    authoritative: true,
    deviceRefs: new Set(),
  });
  assert.equal(pools.find((pool) => pool.id === "gpu0")?.orphaned, true);
  assert.equal(pools.find((pool) => pool.id === "gpu0")?.capacityBytes, 0);
  assert.equal(pools.find((pool) => pool.id === "host")?.orphaned, false);
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
