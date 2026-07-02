import type {
  ApiProxySchedulerAction,
  ApiProxySchedulerPlan,
  ApiProxySchedulerPlanRequest,
  ApiProxySchedulerPoolInput,
  ApiProxyTargetPlanInput,
  InstanceMemoryDraw,
} from "@llama-manager/core";

const activeStates = new Set(["ready"]);
const pendingStates = new Set(["loading"]);

function runtimeState(target: ApiProxyTargetPlanInput) {
  return target.runtime?.state ?? "unknown";
}

function isActive(target: ApiProxyTargetPlanInput) {
  return activeStates.has(runtimeState(target));
}

function isBusy(target: ApiProxyTargetPlanInput) {
  return (target.runtime?.activeRequests ?? 0) > 0;
}

function isManaged(target: ApiProxyTargetPlanInput) {
  return Boolean(target.instanceId);
}

function elapsedMs(now: string, since: string | null | undefined) {
  if (!since) {
    return null;
  }
  const nowMs = Date.parse(now);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(nowMs) || !Number.isFinite(sinceMs)) {
    return null;
  }
  return Math.max(0, nowMs - sinceMs);
}

function action(
  type: ApiProxySchedulerAction["type"],
  target: ApiProxyTargetPlanInput,
  reason: string,
  slotId: number | null = null,
): ApiProxySchedulerAction {
  return {
    type,
    targetId: target.id,
    instanceId: target.instanceId,
    model: target.model,
    slotId,
    reason,
  };
}

function blocked(
  request: ApiProxySchedulerPlanRequest,
  blockingReason: string,
): ApiProxySchedulerPlan {
  return {
    ok: false,
    mode: request.mode,
    requestedTargetId: request.requestedTargetId ?? null,
    actions: [],
    preemptTargetIds: [],
    blockingReason,
  };
}

function unloadActions(
  target: ApiProxyTargetPlanInput,
  reason: string,
): ApiProxySchedulerAction[] {
  if (!isManaged(target)) {
    return [];
  }

  const actions: ApiProxySchedulerAction[] = [];
  if (target.saveSlotsBeforeUnload) {
    const alreadySaved = new Set(target.runtime?.savedSlotIds ?? []);
    for (const slotId of target.slotIds) {
      if (!alreadySaved.has(slotId)) {
        actions.push(action("save-slot", target, reason, slotId));
      }
    }
  }

  actions.push(
    target.model
      ? action("unload-model", target, reason)
      : action("stop-instance", target, reason),
  );
  return actions;
}

function loadActions(
  target: ApiProxyTargetPlanInput,
  reason: string,
): ApiProxySchedulerAction[] {
  if (!isManaged(target)) {
    return [];
  }

  const state = runtimeState(target);
  const actions: ApiProxySchedulerAction[] = [];

  if (state === "stopped" || state === "unknown") {
    actions.push(action("start-instance", target, reason));
    actions.push(action("wait-instance-ready", target, reason));
  }

  if (pendingStates.has(state)) {
    actions.push(action("wait-model-ready", target, reason));
  }

  if (!isActive(target) && !pendingStates.has(state) && target.model) {
    actions.push(action("load-model", target, reason));
    actions.push(action("wait-model-ready", target, reason));
  }

  for (const slotId of target.runtime?.savedSlotIds ?? []) {
    actions.push(action("restore-slot", target, reason, slotId));
  }

  return actions;
}

function drawByPool(draws: InstanceMemoryDraw[]): Map<string, number> {
  const byPool = new Map<string, number>();
  for (const draw of draws) {
    byPool.set(draw.poolId, (byPool.get(draw.poolId) ?? 0) + draw.bytes);
  }
  return byPool;
}

type MemoryPeerInstance = {
  instanceId: string;
  target: ApiProxyTargetPlanInput;
  draw: Map<string, number>;
  busy: boolean;
  preemptible: boolean;
  priority: number;
  idleForMs: number | null;
};

function collectMemoryPeerInstances(
  request: ApiProxySchedulerPlanRequest,
  target: ApiProxyTargetPlanInput,
  freedInstanceIds: Set<string>,
): Map<string, MemoryPeerInstance> {
  const peers = new Map<string, MemoryPeerInstance>();
  for (const item of request.targets) {
    if (item.id === target.id || !isManaged(item) || !isActive(item)) {
      continue;
    }
    const instanceId = item.instanceId;
    if (
      !instanceId ||
      instanceId === target.instanceId ||
      freedInstanceIds.has(instanceId) ||
      item.draws.length === 0
    ) {
      continue;
    }
    const existing = peers.get(instanceId);
    if (existing) {
      existing.busy = existing.busy || isBusy(item);
      existing.preemptible = existing.preemptible && item.preemptible;
      existing.priority = Math.max(existing.priority, item.priority);
      if (!existing.target.model && item.model) {
        existing.target = item;
      }
      continue;
    }
    peers.set(instanceId, {
      instanceId,
      target: item,
      draw: drawByPool(item.draws),
      busy: isBusy(item),
      preemptible: item.preemptible,
      priority: item.priority,
      idleForMs: elapsedMs(request.now, item.runtime?.idleSince),
    });
  }
  return peers;
}

function drawOnPools(peer: MemoryPeerInstance, pools: Set<string>): number {
  let bytes = 0;
  for (const [poolId, value] of peer.draw) {
    if (pools.has(poolId)) {
      bytes += value;
    }
  }
  return bytes;
}

type MemoryFitResult =
  | { ok: true; actions: ApiProxySchedulerAction[]; preemptTargetIds: string[] }
  | { ok: false; reason: string };

function planMemoryEvictions(
  request: ApiProxySchedulerPlanRequest,
  target: ApiProxyTargetPlanInput,
  freedInstanceIds: Set<string>,
  allowBusyEviction: boolean,
): MemoryFitResult {
  const targetDraw = drawByPool(target.draws);
  if (
    targetDraw.size === 0 ||
    request.pools.length === 0 ||
    isActive(target) ||
    !isManaged(target)
  ) {
    return { ok: true, actions: [], preemptTargetIds: [] };
  }

  const poolById = new Map<string, ApiProxySchedulerPoolInput>(
    request.pools.map((pool) => [pool.poolId, pool]),
  );
  const protectedTargetIds = new Set(request.protectedTargetIds ?? []);
  const pinnedTargetIds = new Set(request.pinnedTargetIds ?? []);
  const kept = collectMemoryPeerInstances(request, target, freedInstanceIds);

  const freeFor = (poolId: string): number => {
    const pool = poolById.get(poolId);
    if (!pool) {
      return 0;
    }
    let used = 0;
    for (const peer of kept.values()) {
      used += peer.draw.get(poolId) ?? 0;
    }
    return pool.budgetBytes - pool.usedByOthersBytes - used;
  };

  const deficitPools = (): string[] => {
    const deficits: string[] = [];
    for (const [poolId, needed] of targetDraw) {
      if (needed > 0 && needed > freeFor(poolId)) {
        deficits.push(poolId);
      }
    }
    return deficits;
  };

  const actions: ApiProxySchedulerAction[] = [];
  const preemptTargetIds: string[] = [];
  while (true) {
    const deficits = deficitPools();
    if (deficits.length === 0) {
      return { ok: true, actions, preemptTargetIds };
    }
    const deficitSet = new Set(deficits);
    const eligible = (peer: MemoryPeerInstance, busy: boolean): boolean =>
      peer.preemptible &&
      !pinnedTargetIds.has(peer.target.id) &&
      peer.busy === busy &&
      drawOnPools(peer, deficitSet) > 0 &&
      (busy
        ? peer.priority < target.priority
        : peer.priority <= target.priority);

    const idleVictims = [...kept.values()].filter((peer) =>
      eligible(peer, false),
    );
    const busyVictims = allowBusyEviction
      ? [...kept.values()].filter((peer) => eligible(peer, true))
      : [];

    const tier = idleVictims.length > 0 ? idleVictims : busyVictims;
    if (tier.length === 0) {
      return {
        ok: false,
        reason: `${target.name} does not fit available memory on pool(s) ${deficits.join(", ")}; no preemptible models available to evict`,
      };
    }
    tier.sort(
      (left, right) =>
        Number(protectedTargetIds.has(left.target.id)) -
          Number(protectedTargetIds.has(right.target.id)) ||
        left.priority - right.priority ||
        (right.idleForMs ?? 0) - (left.idleForMs ?? 0) ||
        drawOnPools(right, deficitSet) - drawOnPools(left, deficitSet),
    );
    const victim = tier[0];
    if (!victim) {
      return { ok: true, actions, preemptTargetIds };
    }
    kept.delete(victim.instanceId);
    actions.push(
      ...unloadActions(
        victim.target,
        `${target.name} needs memory; evicting ${victim.busy ? "busy" : "idle"} ${victim.target.name}`,
      ),
    );
    if (victim.busy) {
      preemptTargetIds.push(victim.target.id);
    }
  }
}

export type PlanRequestOptions = {
  allowBusyEviction?: boolean;
};

export function planApiProxyRequest(
  request: ApiProxySchedulerPlanRequest,
  options: PlanRequestOptions = {},
): ApiProxySchedulerPlan {
  if (request.mode !== "request") {
    throw new Error("planApiProxyRequest expects request mode");
  }
  if (!request.requestedTargetId) {
    return blocked(request, "requestedTargetId is required");
  }

  const target = request.targets.find(
    (item) => item.id === request.requestedTargetId,
  );
  if (!target) {
    return blocked(
      request,
      `proxy target ${request.requestedTargetId} not found`,
    );
  }
  if (runtimeState(target) === "error") {
    return blocked(request, `proxy target ${target.name} is in error state`);
  }

  const actions: ApiProxySchedulerAction[] = [];
  const memory = planMemoryEvictions(
    request,
    target,
    new Set<string>(),
    options.allowBusyEviction ?? false,
  );
  if (!memory.ok) {
    return blocked(request, memory.reason);
  }
  actions.push(...memory.actions);

  actions.push(...loadActions(target, `${target.name} request arrived`));
  actions.push(action("route-request", target, "target is selected"));

  return {
    ok: true,
    mode: request.mode,
    requestedTargetId: target.id,
    actions,
    preemptTargetIds: memory.preemptTargetIds,
    blockingReason: null,
  };
}

export function planApiProxyIdleMaintenance(
  request: ApiProxySchedulerPlanRequest,
): ApiProxySchedulerPlan {
  if (request.mode !== "idle") {
    throw new Error("planApiProxyIdleMaintenance expects idle mode");
  }

  const pinnedTargetIds = new Set(request.pinnedTargetIds ?? []);
  const actions: ApiProxySchedulerAction[] = [];
  const unloadCandidates = request.targets.filter((target) => {
    if (!isActive(target) || isBusy(target) || pinnedTargetIds.has(target.id)) {
      return false;
    }
    if (target.idleUnloadMs === null) {
      return false;
    }
    const idleForMs = elapsedMs(request.now, target.runtime?.idleSince);
    return idleForMs !== null && idleForMs >= target.idleUnloadMs;
  });

  for (const target of unloadCandidates) {
    actions.push(
      ...unloadActions(target, `${target.name} exceeded idle unload threshold`),
    );
  }

  const preferredTarget = request.preferredTargetId
    ? request.targets.find((target) => target.id === request.preferredTargetId)
    : null;
  if (preferredTarget && !isActive(preferredTarget)) {
    const freedInstanceIds = new Set(
      unloadCandidates
        .map((candidate) => candidate.instanceId)
        .filter((id): id is string => Boolean(id)),
    );
    const fit = planMemoryEvictions(
      request,
      preferredTarget,
      freedInstanceIds,
      false,
    );
    if (fit.ok && fit.actions.length === 0) {
      actions.push(
        ...loadActions(
          preferredTarget,
          `${preferredTarget.name} is preferred after idle maintenance`,
        ),
      );
    }
  }

  return {
    ok: true,
    mode: request.mode,
    requestedTargetId: null,
    actions,
    preemptTargetIds: [],
    blockingReason: null,
  };
}
