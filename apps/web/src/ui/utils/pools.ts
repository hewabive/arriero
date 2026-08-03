import type { MemoryPool, SystemAccelerator } from "@arriero/core";

function formatGpuName(index: string, name: string): string {
  return `GPU ${index} · ${name}`;
}

export function formatMemoryPoolName(
  pool: Pick<MemoryPool, "kind" | "deviceRef" | "name">,
): string {
  if (pool.kind === "gpu" && pool.deviceRef !== null) {
    return formatGpuName(pool.deviceRef, pool.name);
  }
  return pool.name;
}

export function formatAcceleratorName(
  accelerator: Pick<SystemAccelerator, "kind" | "id" | "name">,
): string {
  return accelerator.kind === "gpu"
    ? formatGpuName(accelerator.id, accelerator.name)
    : accelerator.name;
}
