import {
  MemoryPoolSchema,
  type MemoryPool,
  type MemoryPoolUpdate,
  type SystemResources,
} from "@arriero/core";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { getSystemResources } from "../system/resources.js";

export const RESOURCES_FILE = resolve(config.configDir, "resources.json");

const GIB = 1024 ** 3;
const HOST_RESERVE_RATIO = 0.15;

let cache: MemoryPool[] | null = null;

function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function load(): MemoryPool[] {
  if (cache) {
    return cache;
  }
  let pools: MemoryPool[] = [];
  if (existsSync(RESOURCES_FILE)) {
    const raw = readFileSync(RESOURCES_FILE, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${RESOURCES_FILE}: ${(error as Error).message}`,
      );
    }
    const parsed = z.array(MemoryPoolSchema).safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Invalid config in ${RESOURCES_FILE}: ${parsed.error.message}`,
      );
    }
    pools = parsed.data;
  }
  cache = pools;
  return pools;
}

function persist(pools: MemoryPool[]) {
  atomicWrite(RESOURCES_FILE, `${JSON.stringify(pools, null, 2)}\n`);
  cache = pools;
}

function sortPools(pools: MemoryPool[]): MemoryPool[] {
  return [...pools].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function floorToGib(bytes: number): number {
  return Math.floor(bytes / GIB) * GIB;
}

export function defaultPoolsFromHardware(
  detected: SystemResources = getSystemResources(),
): MemoryPool[] {
  const timestamp = nowIso();
  const pools: MemoryPool[] = [];
  for (const accelerator of detected.accelerators) {
    if (accelerator.kind !== "gpu") {
      continue;
    }
    pools.push({
      id: `gpu${accelerator.id}`,
      name: accelerator.name,
      kind: "gpu",
      capacityBytes: accelerator.totalMemoryBytes ?? 0,
      reservedBytes: 0,
      deviceRef: accelerator.id,
      autoCapacity: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  pools.push({
    id: "host",
    name: "Host RAM",
    kind: "host",
    capacityBytes: detected.memory.totalBytes,
    reservedBytes: floorToGib(detected.memory.totalBytes * HOST_RESERVE_RATIO),
    deviceRef: null,
    autoCapacity: true,
    createdAt: timestamp,
    updatedAt: timestamp,
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
    return { ...pool, capacityBytes, updatedAt: nowIso() };
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
    const timestamp = nowIso();
    next.push({
      id,
      name: accelerator.name,
      kind: "gpu",
      capacityBytes: accelerator.totalMemoryBytes ?? 0,
      reservedBytes: 0,
      deviceRef: accelerator.id,
      autoCapacity: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    knownDeviceRefs.add(accelerator.id);
    knownIds.add(id);
    changed = true;
  }
  if (changed) {
    cache = next;
  }
  return changed;
}

export function listMemoryPools(): MemoryPool[] {
  return sortPools(load());
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
    updatedAt: nowIso(),
  };
  persist(pools.map((pool) => (pool.id === id ? updated : pool)));
  return updated;
}

export function resetResourcePoolsCache(): void {
  cache = null;
}
