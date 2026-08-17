import {
  deriveInstanceResourceProfile,
  engineDescriptor,
  type Instance,
  type InstanceResourceProfile,
} from "@arriero/core";

import { cachedGpuLayersDefault } from "../arguments/binary-defaults.js";
import { getCachedModelEntry } from "../models/cache-repository.js";
import { listMemoryPools } from "../resources/repository.js";

function modelMetadata(
  instance: Instance,
): { blockCount: number | null; expertCount: number | null } | null {
  const raw = instance.args["--model"] ?? instance.args["-m"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const cached = getCachedModelEntry(raw.trim())?.model;
  if (!cached) {
    return null;
  }
  return {
    blockCount: cached.metadata.blockCount,
    expertCount: cached.metadata.expertCount,
  };
}

function instanceResourceProfile(
  instance: Instance,
  pools = listMemoryPools(),
): InstanceResourceProfile {
  return deriveInstanceResourceProfile({
    kind: instance.kind,
    args: instance.args,
    env: instance.env,
    memory: instance.memory,
    pools: pools.map((pool) => ({
      id: pool.id,
      kind: pool.kind,
      deviceRef: pool.deviceRef,
      name: pool.name,
    })),
    model: modelMetadata(instance),
    gpuLayersDefault:
      engineDescriptor(instance.kind).resourceProfile === "llama-args"
        ? cachedGpuLayersDefault(instance.binaryPath)
        : null,
  });
}

export function instanceResourceProfiles(
  instances: Instance[],
): Record<string, InstanceResourceProfile> {
  const pools = listMemoryPools();
  const result: Record<string, InstanceResourceProfile> = {};
  for (const instance of instances) {
    result[instance.name] = instanceResourceProfile(instance, pools);
  }
  return result;
}
