import {
  InstanceHealthSummarySchema,
  type ApiEndpointRecord,
  type ApiProxyTargetRecord,
  type InstanceHealthSummary,
} from "@arriero/core";

import { fetchNodeJson } from "../nodes/remote.js";
import { getNode } from "../nodes/repository.js";
import { createCachedSingleFlight } from "../utils/cached-single-flight.js";

const CACHE_TTL_MS = 3000;
const REMOTE_HEALTH_TIMEOUT_MS = 4000;

const remoteHealthCache =
  createCachedSingleFlight<InstanceHealthSummary | null>(CACHE_TTL_MS);

function pairKey(nodeId: string, instanceId: string) {
  return `${nodeId}\u0000${instanceId}`;
}

async function loadRemoteInstanceHealth(
  nodeId: string,
  instanceId: string,
): Promise<InstanceHealthSummary | null> {
  const node = getNode(nodeId);
  if (!node || !node.enabled) {
    return null;
  }
  try {
    const raw = await fetchNodeJson<unknown>(
      node,
      `instances/${encodeURIComponent(instanceId)}/health-summary`,
      REMOTE_HEALTH_TIMEOUT_MS,
    );
    return InstanceHealthSummarySchema.parse(raw);
  } catch {
    return null;
  }
}

function readCachedRemoteInstanceHealth(
  nodeId: string,
  instanceId: string,
): InstanceHealthSummary | null {
  return remoteHealthCache.readCached(pairKey(nodeId, instanceId)) ?? null;
}

function fetchRemoteInstanceHealth(
  nodeId: string,
  instanceId: string,
): Promise<InstanceHealthSummary | null> {
  return remoteHealthCache.fetch(pairKey(nodeId, instanceId), () =>
    loadRemoteInstanceHealth(nodeId, instanceId),
  );
}

export type RemoteTargetHealth = {
  remoteManagedTargetIds: Set<string>;
  healthByTargetId: Map<string, InstanceHealthSummary>;
};

export async function collectRemoteTargetHealth(input: {
  targets: ApiProxyTargetRecord[];
  endpoints: ApiEndpointRecord[];
  cacheOnly?: boolean | undefined;
}): Promise<RemoteTargetHealth> {
  const endpointById = new Map(
    input.endpoints.map((endpoint) => [endpoint.id, endpoint]),
  );
  const remoteTargets = input.targets.flatMap((target) => {
    const endpoint = endpointById.get(target.endpointId);
    return endpoint?.nodeId && endpoint.instanceId
      ? [{ target, nodeId: endpoint.nodeId, instanceId: endpoint.instanceId }]
      : [];
  });
  const remoteManagedTargetIds = new Set(
    remoteTargets.map((entry) => entry.target.id),
  );
  if (remoteTargets.length === 0) {
    return { remoteManagedTargetIds, healthByTargetId: new Map() };
  }

  const pairs = new Map<string, { nodeId: string; instanceId: string }>();
  for (const entry of remoteTargets) {
    pairs.set(pairKey(entry.nodeId, entry.instanceId), {
      nodeId: entry.nodeId,
      instanceId: entry.instanceId,
    });
  }

  const healthByPair = new Map<string, InstanceHealthSummary>();
  await Promise.all(
    [...pairs].map(async ([key, pair]) => {
      const health = input.cacheOnly
        ? readCachedRemoteInstanceHealth(pair.nodeId, pair.instanceId)
        : await fetchRemoteInstanceHealth(pair.nodeId, pair.instanceId);
      if (health) {
        healthByPair.set(key, health);
      }
    }),
  );

  const healthByTargetId = new Map<string, InstanceHealthSummary>();
  for (const entry of remoteTargets) {
    const health = healthByPair.get(pairKey(entry.nodeId, entry.instanceId));
    if (health) {
      healthByTargetId.set(entry.target.id, health);
    }
  }

  return { remoteManagedTargetIds, healthByTargetId };
}
