import { performance } from "node:perf_hooks";

import type { Instance, InstanceHealthSummary } from "@arriero/core";

import { getInstanceHealthSummary } from "../process/health-summary.js";

type Entry = { at: number; value: InstanceHealthSummary };

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<InstanceHealthSummary>>();

function computeAndStore(
  instance: Instance,
  peers: Instance[],
): Promise<InstanceHealthSummary> {
  const key = instance.name;
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  const task = getInstanceHealthSummary(instance, {
    peers,
    checkStartAvailability: false,
  })
    .then((value) => {
      cache.set(key, { at: performance.now(), value });
      return value;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, task);
  return task;
}

export function getResidencyHealth(
  instance: Instance,
  peers: Instance[],
  options?: { fresh?: boolean | undefined },
): Promise<InstanceHealthSummary> {
  if (!options?.fresh) {
    const cached = cache.get(instance.name);
    if (cached) {
      return Promise.resolve(cached.value);
    }
  }
  return computeAndStore(instance, peers);
}

export async function refreshResidencyHealth(
  instances: Instance[],
  peers: Instance[],
): Promise<void> {
  await Promise.all(
    instances.map((instance) => computeAndStore(instance, peers)),
  );
  const active = new Set(instances.map((instance) => instance.name));
  for (const name of [...cache.keys()]) {
    if (!active.has(name)) {
      cache.delete(name);
    }
  }
}

export function resetResidencyHealthCache(): void {
  cache.clear();
  pending.clear();
}
