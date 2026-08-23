import type {
  ApiEndpointRecord,
  ApiProxyInflightRequest,
  ApiProxyTargetRecord,
} from "@arriero/core";

import { getInstanceHealthSummary } from "../process/health-summary.js";
import { listInstances } from "../instances/repository.js";
import { startAsyncIntervalLoop } from "../utils/interval-loop.js";
import { computeDomainCoordinator } from "./domain-coordinator.js";
import { apiProxyInflight } from "./inflight.js";
import { getApiEndpointById } from "./endpoints.js";
import {
  getResidencyHealth,
  refreshResidencyHealth,
} from "./instance-health-cache.js";
import {
  listApiProxyRuntimeMetadata,
  listApiProxyTargets,
} from "./repository.js";
import { collectRemoteTargetHealth } from "./remote-health.js";
import {
  collectRemoteDelegatedInflight,
  mergeDelegatedInflight,
} from "./remote-inflight.js";
import { buildApiProxyRuntimeSnapshot } from "./runtime.js";
import { resolveApiProxyTarget } from "./targets.js";

export async function getApiProxyRuntimeSnapshot(options?: {
  extraTarget?: ApiProxyTargetRecord | undefined;
  purpose?: "diagnostics" | "scheduling" | undefined;
  residency?: "cached" | "live" | undefined;
}) {
  const diagnostics = (options?.purpose ?? "diagnostics") === "diagnostics";
  const fresh = options?.residency !== "cached";
  const baseTargets = listApiProxyTargets();
  const candidate = options?.extraTarget ?? null;
  const targets =
    candidate && !baseTargets.some((target) => target.id === candidate.id)
      ? [...baseTargets, candidate]
      : baseTargets;
  const instances = listInstances();
  const endpoints = targets
    .map((target) => getApiEndpointById(target.endpointId, instances))
    .filter((endpoint): endpoint is ApiEndpointRecord => Boolean(endpoint));
  const peers = instances;
  const targetInstanceIds = new Set(
    targets
      .map(
        (target) =>
          resolveApiProxyTarget(target, instances, endpoints).instanceId,
      )
      .filter((instanceId): instanceId is string => Boolean(instanceId)),
  );
  const targetInstances = instances.filter((instance) =>
    targetInstanceIds.has(instance.name),
  );
  const [healthEntries, remote, delegatedInflight] = await Promise.all([
    Promise.all(
      targetInstances.map(
        async (instance) =>
          [
            instance.name,
            diagnostics
              ? await getInstanceHealthSummary(instance, { peers })
              : await getResidencyHealth(instance, peers, { fresh }),
          ] as const,
      ),
    ),
    collectRemoteTargetHealth({ targets, endpoints, cacheOnly: !diagnostics }),
    apiProxyInflight.activeCount() > 0
      ? collectRemoteDelegatedInflight({
          targets,
          endpoints,
          cacheOnly: !diagnostics,
        })
      : new Map<string, ApiProxyInflightRequest>(),
  ]);

  return {
    targets,
    snapshot: buildApiProxyRuntimeSnapshot({
      checkedAt: new Date().toISOString(),
      targets,
      endpoints,
      instances,
      healthByInstanceId: new Map(healthEntries),
      remoteManagedTargetIds: remote.remoteManagedTargetIds,
      remoteHealthByTargetId: remote.healthByTargetId,
      metadataByTargetId: listApiProxyRuntimeMetadata(),
      busyTargetIds: computeDomainCoordinator.busyTargetIds(),
      inflightByTargetId: mergeDelegatedInflight(
        apiProxyInflight.snapshotByTarget(),
        delegatedInflight,
      ),
    }),
  };
}

const SNAPSHOT_CACHE_TTL_MS = 2000;

type ApiProxyRuntimeSnapshotResult = Awaited<
  ReturnType<typeof getApiProxyRuntimeSnapshot>
>;

let cachedSnapshot: {
  at: number;
  value: ApiProxyRuntimeSnapshotResult;
} | null = null;
let pendingSnapshot: Promise<ApiProxyRuntimeSnapshotResult> | null = null;

export async function getCachedApiProxyRuntimeSnapshot(): Promise<ApiProxyRuntimeSnapshotResult> {
  const now = performance.now();
  if (cachedSnapshot && now - cachedSnapshot.at < SNAPSHOT_CACHE_TTL_MS) {
    return cachedSnapshot.value;
  }
  if (pendingSnapshot) {
    return pendingSnapshot;
  }
  pendingSnapshot = (async () => {
    try {
      const value = await getApiProxyRuntimeSnapshot({
        purpose: "scheduling",
        residency: "cached",
      });
      cachedSnapshot = { at: performance.now(), value };
      return value;
    } finally {
      pendingSnapshot = null;
    }
  })();
  return pendingSnapshot;
}

const RUNTIME_RECONCILE_INTERVAL_MS = 1000;

async function reconcileRuntimeState(): Promise<void> {
  const targets = listApiProxyTargets();
  const instances = listInstances();
  const endpoints = targets
    .map((target) => getApiEndpointById(target.endpointId, instances))
    .filter((endpoint): endpoint is ApiEndpointRecord => Boolean(endpoint));
  const targetInstanceIds = new Set(
    targets
      .map(
        (target) =>
          resolveApiProxyTarget(target, instances, endpoints).instanceId,
      )
      .filter((instanceId): instanceId is string => Boolean(instanceId)),
  );
  const targetInstances = instances.filter((instance) =>
    targetInstanceIds.has(instance.name),
  );
  await Promise.all([
    refreshResidencyHealth(targetInstances, instances),
    collectRemoteTargetHealth({ targets, endpoints }),
    apiProxyInflight.activeCount() > 0
      ? collectRemoteDelegatedInflight({ targets, endpoints })
      : Promise.resolve(),
  ]);
}

export function startApiProxyRuntimeReconcileLoop(options?: {
  intervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): () => void {
  return startAsyncIntervalLoop(reconcileRuntimeState, {
    intervalMs: options?.intervalMs ?? RUNTIME_RECONCILE_INTERVAL_MS,
    immediate: true,
    onError: options?.onError,
  });
}
