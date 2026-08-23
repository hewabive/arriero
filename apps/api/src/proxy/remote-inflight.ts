import {
  ApiProxyInflightRequestSchema,
  apiProxyInflightPhaseEnded,
  type ApiEndpointRecord,
  type ApiProxyInflightPhase,
  type ApiProxyInflightRequest,
  type ApiProxyTargetRecord,
} from "@arriero/core";

import { fetchNodeJson } from "../nodes/remote.js";
import { getNode } from "../nodes/repository.js";

const CACHE_TTL_MS = 2000;
const REMOTE_INFLIGHT_TIMEOUT_MS = 4000;

type CacheEntry = { at: number; value: ApiProxyInflightRequest[] };

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ApiProxyInflightRequest[]>>();

async function loadRemoteInflight(
  nodeId: string,
): Promise<ApiProxyInflightRequest[]> {
  const node = getNode(nodeId);
  if (!node || !node.enabled) {
    return [];
  }
  try {
    const raw = await fetchNodeJson<unknown>(
      node,
      "proxy/inflight",
      REMOTE_INFLIGHT_TIMEOUT_MS,
    );
    return ApiProxyInflightRequestSchema.array().parse(raw);
  } catch {
    return [];
  }
}

function readCachedRemoteInflight(nodeId: string): ApiProxyInflightRequest[] {
  return cache.get(nodeId)?.value ?? [];
}

function fetchRemoteInflight(
  nodeId: string,
): Promise<ApiProxyInflightRequest[]> {
  const cached = cache.get(nodeId);
  if (cached && performance.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const existing = pending.get(nodeId);
  if (existing) {
    return existing;
  }
  const task = loadRemoteInflight(nodeId)
    .then((value) => {
      cache.set(nodeId, { at: performance.now(), value });
      return value;
    })
    .finally(() => {
      pending.delete(nodeId);
    });
  pending.set(nodeId, task);
  return task;
}

export async function collectRemoteDelegatedInflight(input: {
  targets: ApiProxyTargetRecord[];
  endpoints: ApiEndpointRecord[];
  cacheOnly?: boolean | undefined;
}): Promise<Map<string, ApiProxyInflightRequest>> {
  const endpointById = new Map(
    input.endpoints.map((endpoint) => [endpoint.id, endpoint]),
  );
  const nodeIds = new Set<string>();
  for (const target of input.targets) {
    const endpoint = endpointById.get(target.endpointId);
    if (endpoint?.nodeId && endpoint.instanceId) {
      nodeIds.add(endpoint.nodeId);
    }
  }
  const byOriginId = new Map<string, ApiProxyInflightRequest>();
  if (nodeIds.size === 0) {
    return byOriginId;
  }
  await Promise.all(
    [...nodeIds].map(async (nodeId) => {
      const entries = input.cacheOnly
        ? readCachedRemoteInflight(nodeId)
        : await fetchRemoteInflight(nodeId);
      for (const entry of entries) {
        if (entry.originId) {
          byOriginId.set(entry.originId, entry);
        }
      }
    }),
  );
  return byOriginId;
}

const ACTIVE_PHASE_RANK: Record<ApiProxyInflightPhase, number> = {
  queued: 0,
  prefilling: 1,
  thinking: 2,
  generating: 3,
  tool: 4,
  done: 5,
  failed: 5,
};

function mergedPhase(
  local: ApiProxyInflightPhase,
  peer: ApiProxyInflightPhase,
): ApiProxyInflightPhase {
  if (apiProxyInflightPhaseEnded(local) || apiProxyInflightPhaseEnded(peer)) {
    return local;
  }
  return ACTIVE_PHASE_RANK[local] <= ACTIVE_PHASE_RANK.prefilling
    ? peer
    : local;
}

export function enrichDelegatedInflightView(
  local: ApiProxyInflightRequest,
  peer: ApiProxyInflightRequest,
): ApiProxyInflightRequest {
  return {
    ...local,
    phase: mergedPhase(local.phase, peer.phase),
    waitingMs: Math.max(local.waitingMs, peer.waitingMs),
    prefillMs: peer.prefillMs ?? local.prefillMs,
    thinkingMs: local.thinkingMs ?? peer.thinkingMs,
    generatingMs: local.generatingMs ?? peer.generatingMs,
    promptTokens: peer.promptTokens ?? local.promptTokens,
    completionTokens: Math.max(local.completionTokens, peer.completionTokens),
    prefillTotalTokens: peer.prefillTotalTokens ?? local.prefillTotalTokens,
    prefillProcessedTokens:
      peer.prefillProcessedTokens ?? local.prefillProcessedTokens,
    prefillCachedTokens: peer.prefillCachedTokens ?? local.prefillCachedTokens,
    reasoningChars: Math.max(local.reasoningChars, peer.reasoningChars),
    answerChars: Math.max(local.answerChars, peer.answerChars),
    toolCalls: Math.max(local.toolCalls, peer.toolCalls),
  };
}

export function mergeDelegatedInflight(
  local: Map<string, ApiProxyInflightRequest[]>,
  peers: Map<string, ApiProxyInflightRequest>,
): Map<string, ApiProxyInflightRequest[]> {
  if (peers.size === 0) {
    return local;
  }
  const merged = new Map<string, ApiProxyInflightRequest[]>();
  for (const [targetId, requests] of local) {
    merged.set(
      targetId,
      requests.map((request) => {
        const peer = peers.get(request.id);
        return peer ? enrichDelegatedInflightView(request, peer) : request;
      }),
    );
  }
  return merged;
}
