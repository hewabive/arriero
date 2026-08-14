import {
  MemoryPoolSchema,
  type MemoryPool,
  type MemoryPoolUpdate,
  type MemoryPoolView,
  type SystemResources,
} from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { logger } from "../logger.js";
import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import {
  getKnownGpuInventory,
  getSystemResources,
  type GpuInventory,
} from "../system/resources.js";

export const RESOURCES_FILE = resolve(config.configDir, "resources.json");

const GIB = 1024 ** 3;
const HOST_RESERVE_RATIO = 0.15;

const store = createJsonFileStore<MemoryPool[]>({
  id: "resources",
  path: RESOURCES_FILE,
  schema: z.array(MemoryPoolSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

function load(): MemoryPool[] {
  return store.read();
}

export function rewriteResourcePoolsFile(): void {
  persist(load());
}

function persist(pools: MemoryPool[]) {
  store.write(pools);
}

function sortPools(pools: MemoryPool[]): MemoryPool[] {
  return [...pools].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function logUnknownAcceleratorCapacity(accelerator: {
  id: string;
  name: string;
}): void {
  logger.warn(
    { deviceRef: accelerator.id, name: accelerator.name },
    "no memory pool scaffolded for gpu: its total memory could not be read",
  );
}

function floorToGib(bytes: number): number {
  return Math.floor(bytes / GIB) * GIB;
}

function gpuPoolFromAccelerator(
  accelerator: SystemResources["accelerators"][number],
  id: string,
): MemoryPool | null {
  if (accelerator.totalMemoryBytes === null) {
    logUnknownAcceleratorCapacity(accelerator);
    return null;
  }
  return {
    id,
    name: accelerator.name,
    kind: "gpu",
    capacityBytes: accelerator.totalMemoryBytes,
    reservedBytes: 0,
    deviceRef: accelerator.id,
    autoCapacity: true,
  };
}

function defaultPoolsFromHardware(
  detected: SystemResources = getSystemResources(),
): MemoryPool[] {
  const pools: MemoryPool[] = [];
  for (const accelerator of detected.accelerators) {
    if (accelerator.kind !== "gpu") {
      continue;
    }
    const pool = gpuPoolFromAccelerator(accelerator, `gpu${accelerator.id}`);
    if (pool) {
      pools.push(pool);
    }
  }
  pools.push({
    id: "host",
    name: "Host RAM",
    kind: "host",
    capacityBytes: detected.memory.totalBytes,
    reservedBytes: floorToGib(detected.memory.totalBytes * HOST_RESERVE_RATIO),
    deviceRef: null,
    autoCapacity: true,
  });
  return sortPools(pools);
}

export function ensureResourcePoolsScaffold(
  detected: SystemResources = getSystemResources(),
): boolean {
  if (existsSync(RESOURCES_FILE)) {
    return false;
  }
  persist(defaultPoolsFromHardware(detected));
  return true;
}

export function refreshAutoCapacities(
  detected: SystemResources = getSystemResources(),
): boolean {
  const pools = load();
  const acceleratorById = new Map(
    detected.accelerators.map((accelerator) => [accelerator.id, accelerator]),
  );
  let changed = false;
  const next = pools.map((pool) => {
    if (!pool.autoCapacity) {
      return pool;
    }
    let capacityBytes: number | null = null;
    if (pool.kind === "host") {
      capacityBytes = detected.memory.totalBytes;
    } else if (pool.deviceRef) {
      capacityBytes =
        acceleratorById.get(pool.deviceRef)?.totalMemoryBytes ?? null;
    }
    if (capacityBytes === null || capacityBytes === pool.capacityBytes) {
      return pool;
    }
    changed = true;
    return { ...pool, capacityBytes };
  });
  const knownDeviceRefs = new Set(
    next
      .filter((pool) => pool.kind === "gpu" && pool.deviceRef)
      .map((pool) => pool.deviceRef),
  );
  const knownIds = new Set(next.map((pool) => pool.id));
  for (const accelerator of detected.accelerators) {
    if (accelerator.kind !== "gpu" || knownDeviceRefs.has(accelerator.id)) {
      continue;
    }
    const baseId = `gpu${accelerator.id}`;
    let id = baseId;
    let suffix = 2;
    while (knownIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const pool = gpuPoolFromAccelerator(accelerator, id);
    if (!pool) {
      continue;
    }
    next.push(pool);
    knownDeviceRefs.add(accelerator.id);
    knownIds.add(id);
    changed = true;
  }
  if (next.length > pools.length) {
    persist(sortPools(next));
  } else if (changed) {
    store.replaceCachedValue(next);
  }
  return changed;
}

export function listMemoryPools(): MemoryPool[] {
  return sortPools(load());
}

export function isMemoryPoolOrphaned(
  pool: MemoryPool,
  inventory: GpuInventory,
): boolean {
  return (
    pool.kind === "gpu" &&
    pool.deviceRef !== null &&
    inventory.authoritative &&
    !inventory.deviceRefs.has(pool.deviceRef)
  );
}

export function listMemoryPoolsWithStatus(
  inventory: GpuInventory = getKnownGpuInventory(),
): MemoryPoolView[] {
  return listMemoryPools().map((pool) => ({
    ...pool,
    orphaned: isMemoryPoolOrphaned(pool, inventory),
  }));
}

export function getMemoryPool(id: string): MemoryPool | null {
  return load().find((pool) => pool.id === id) ?? null;
}

export function updateMemoryPool(
  id: string,
  input: MemoryPoolUpdate,
): MemoryPool | null {
  const pools = load();
  const current = pools.find((pool) => pool.id === id);
  if (!current) {
    return null;
  }
  const updated: MemoryPool = {
    ...current,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.capacityBytes !== undefined
      ? { capacityBytes: input.capacityBytes }
      : {}),
    ...(input.reservedBytes !== undefined
      ? { reservedBytes: input.reservedBytes }
      : {}),
    ...(input.autoCapacity !== undefined
      ? { autoCapacity: input.autoCapacity }
      : {}),
  };
  persist(pools.map((pool) => (pool.id === id ? updated : pool)));
  return updated;
}

export function deleteMemoryPool(id: string): boolean {
  const pools = load();
  const next = pools.filter((pool) => pool.id !== id);
  if (next.length === pools.length) {
    return false;
  }
  persist(next);
  return true;
}

export function resetResourcePoolsCache(): void {
  store.reset();
}
