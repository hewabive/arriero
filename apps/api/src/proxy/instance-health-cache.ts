import { performance } from "node:perf_hooks";

import type { Instance, InstanceHealthSummary } from "@arriero/core";

import { logger } from "../logger.js";
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
      const previous = cache.get(key);
      if (previous && previous.value.status !== value.status) {
        logger.info(
          {
            instanceId: key,
            from: previous.value.status,
            to: value.status,
            reason: value.reason,
          },
          "instance health status changed",
        );
      }
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
