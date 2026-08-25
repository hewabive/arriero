import {
  MemoryPoolDeclarationSchema,
  stripLegacyConfigTimestamps,
  type MemoryPool,
  type MemoryPoolDeclaration,
  type MemoryPoolUpdate,
  type MemoryPoolView,
  type SystemResources,
} from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

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

function normalizeStoredPoolDeclaration(value: unknown): unknown {
  const stripped = stripLegacyConfigTimestamps(value);
  if (
    typeof stripped !== "object" ||
    stripped === null ||
    Array.isArray(stripped)
  ) {
    return stripped;
  }
  const record = stripped as Record<string, unknown>;
  if (record.autoCapacity === false || record.capacityBytes == null) {
    return stripped;
  }
  return { ...record, capacityBytes: null };
}

const StoredPoolDeclarationSchema: z.ZodType<MemoryPoolDeclaration> =
  z.preprocess(normalizeStoredPoolDeclaration, MemoryPoolDeclarationSchema);

const store = createJsonFileStore<MemoryPoolDeclaration[]>({
  id: "resources",
  path: RESOURCES_FILE,
  schema: z.array(StoredPoolDeclarationSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

function load(): MemoryPoolDeclaration[] {
  return store.read();
}

export function rewriteResourcePoolsFile(): void {
  persist(load());
}

function persist(pools: MemoryPoolDeclaration[]) {
  store.write(sortPools(pools));
}

function sortPools<T extends { kind: string; id: string }>(pools: T[]): T[] {
  return [...pools].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function floorToGib(bytes: number): number {
  return Math.floor(bytes / GIB) * GIB;
}

function uniquePoolId(baseId: string, taken: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function defaultPoolsFromHardware(
  detected: SystemResources,
): MemoryPoolDeclaration[] {
  const pools: MemoryPoolDeclaration[] = [];
  for (const accelerator of detected.accelerators) {
    if (accelerator.kind !== "gpu") {
      continue;
    }
    pools.push({
      id: `gpu${accelerator.id}`,
      name: accelerator.name,
      kind: "gpu",
      capacityBytes: null,
      reservedBytes: 0,
      deviceRef: accelerator.id,
      autoCapacity: true,
    });
  }
  pools.push({
    id: "host",
    name: "Host RAM",
    kind: "host",
    capacityBytes: null,
    reservedBytes: floorToGib(detected.memory.totalBytes * HOST_RESERVE_RATIO),
    deviceRef: null,
    autoCapacity: true,
  });
  return pools;
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

export function listDeclaredMemoryPools(): MemoryPoolDeclaration[] {
  return sortPools(load());
}

export function isMemoryPoolOrphaned(
  pool: Pick<MemoryPoolDeclaration, "kind" | "deviceRef">,
  inventory: GpuInventory,
): boolean {
  return (
    pool.kind === "gpu" &&
    pool.deviceRef !== null &&
    inventory.authoritative &&
    !inventory.deviceRefs.has(pool.deviceRef)
  );
}

function effectiveCapacityBytes(
  declaration: MemoryPoolDeclaration,
  detected: SystemResources,
  inventory: GpuInventory,
): number {
  if (!declaration.autoCapacity) {
    return declaration.capacityBytes ?? 0;
  }
  if (declaration.kind === "host") {
    return detected.memory.totalBytes;
  }
  if (isMemoryPoolOrphaned(declaration, inventory)) {
    return 0;
  }
  const accelerator = declaration.deviceRef
    ? detected.accelerators.find(
        (candidate) => candidate.id === declaration.deviceRef,
      )
    : undefined;
  return accelerator?.totalMemoryBytes ?? 0;
}

export function listMemoryPools(): MemoryPool[] {
  const detected = getSystemResources();
  const inventory = getKnownGpuInventory();
  return listDeclaredMemoryPools().map((declaration) => ({
    ...declaration,
    capacityBytes: effectiveCapacityBytes(declaration, detected, inventory),
  }));
}

export function listMemoryPoolsWithStatus(
  inventory: GpuInventory = getKnownGpuInventory(),
): MemoryPoolView[] {
  return listMemoryPools().map((pool) => ({
    ...pool,
    orphaned: isMemoryPoolOrphaned(pool, inventory),
  }));
}

export function listUndeclaredAccelerators(
  detected: SystemResources = getSystemResources(),
): SystemResources["accelerators"] {
  const declaredRefs = new Set(
    load()
      .filter((pool) => pool.kind === "gpu" && pool.deviceRef)
      .map((pool) => pool.deviceRef),
  );
  return detected.accelerators.filter(
    (accelerator) =>
      accelerator.kind === "gpu" && !declaredRefs.has(accelerator.id),
  );
}

export function declareGpuPool(
  deviceRef: string,
): MemoryPoolDeclaration | null {
  const detected = getSystemResources();
  const accelerator = detected.accelerators.find(
    (candidate) => candidate.kind === "gpu" && candidate.id === deviceRef,
  );
  if (!accelerator) {
    return null;
  }
  const pools = load();
  const existing = pools.find(
    (pool) => pool.kind === "gpu" && pool.deviceRef === deviceRef,
  );
  if (existing) {
    return existing;
  }
  const declaration = MemoryPoolDeclarationSchema.parse({
    id: uniquePoolId(`gpu${deviceRef}`, new Set(pools.map((pool) => pool.id))),
    name: accelerator.name,
    kind: "gpu",
    capacityBytes: null,
    reservedBytes: 0,
    deviceRef,
    autoCapacity: true,
  });
  persist([...pools, declaration]);
  return declaration;
}

export function getMemoryPool(id: string): MemoryPoolDeclaration | null {
  return load().find((pool) => pool.id === id) ?? null;
}

export function updateMemoryPool(
  id: string,
  input: MemoryPoolUpdate,
): MemoryPoolDeclaration | null {
  const pools = load();
  const current = pools.find((pool) => pool.id === id);
  if (!current) {
    return null;
  }
  const nextAuto = input.autoCapacity ?? current.autoCapacity;
  const updated = MemoryPoolDeclarationSchema.parse({
    ...current,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.reservedBytes !== undefined
      ? { reservedBytes: input.reservedBytes }
      : {}),
    autoCapacity: nextAuto,
    capacityBytes: nextAuto
      ? null
      : (input.capacityBytes ?? current.capacityBytes),
  });
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
