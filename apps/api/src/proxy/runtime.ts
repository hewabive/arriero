import {
  apiProxyInflightPhaseEnded,
  type ApiEndpointRecord,
  type ApiProxyInflightRequest,
  type ApiProxyModelState,
  type ApiProxyRuntimeSnapshot,
  type ApiProxyRuntimeMetadataRecord,
  type ApiProxyTargetRecord,
  type ApiProxyTargetRuntime,
  type Instance,
  type InstanceHealthSummary,
  type EndpointProbe,
} from "@arriero/core";

import { asObject } from "./json.js";
import type { ApiProxySlotActivity } from "./inflight.js";
import {
  apiProxyTargetSlotAvailability,
  isRouterUpstream,
  targetSlotPools,
  type TargetSlotPool,
} from "./target-availability.js";
import { resolveApiProxyTarget } from "./targets.js";

type RuntimeTracker = {
  idleSince: string | null;
  lastRequestAt: string | null;
  savedSlotIds: number[];
};

const runtimeTrackers = new Map<string, RuntimeTracker>();

function slotRecords(probe: EndpointProbe | undefined) {
  if (!probe?.ok || !Array.isArray(probe.body)) {
    return [];
  }

  return probe.body
    .map((slot) => asObject(slot))
    .filter((slot): slot is Record<string, unknown> => Boolean(slot));
}

function activeRequestsFromSlots(probe: EndpointProbe | undefined) {
  return slotRecords(probe).filter((slot) => slot.is_processing === true)
    .length;
}

function modelStatusFromProbe(
  probe: EndpointProbe | null | undefined,
  model: string,
) {
  const body = asObject(probe?.body);
  const data = Array.isArray(body?.data) ? body.data : [];
  const match = data
    .map((item) => asObject(item))
    .find((record) => record?.id === model);
  if (!match) {
    return null;
  }

  const status = asObject(match.status);
  if (status?.failed === true) {
    return "failed";
  }
  if (typeof status?.value === "string") {
    return status.value.toLowerCase();
  }
  return probe?.ok ? "loaded" : null;
}

function modelScopedSlots(
  health: InstanceHealthSummary | undefined,
  model: string,
) {
  return (
    health?.probe.llama?.modelDiagnostics[model]?.slots ??
    health?.probe.llama?.slots
  );
}

function modelRuntimeState(modelStatus: string | null): ApiProxyModelState {
  if (modelStatus === "failed") {
    return "error";
  }
  if (modelStatus === "loading") {
    return "loading";
  }
  if (modelStatus === "unloaded") {
    return "unloaded";
  }
  if (
    modelStatus === "loaded" ||
    modelStatus === "sleeping" ||
    modelStatus === "ready" ||
    modelStatus === "running"
  ) {
    return "ready";
  }
  return "unknown";
}

function processRuntimeState(
  health: InstanceHealthSummary,
): ApiProxyModelState {
  if (health.status === "invalid") {
    return "error";
  }
  if (health.status === "error") {
    return health.actions.canStart ? "stopped" : "error";
  }
  if (health.status === "starting" || health.status === "loading") {
    return "loading";
  }
  if (health.status === "stale") {
    if (health.probe.health.ok) {
      return "ready";
    }
    if (health.probe.health.status === 503) {
      return "loading";
    }
    return "stopped";
  }
  if (health.status === "stopped") {
    return "stopped";
  }
  if (health.status === "ready" || health.status === "degraded") {
    return "ready";
  }
  return "unknown";
}

function lastLogErrors(health: InstanceHealthSummary) {
  return health.logSummary.errors.slice(-3);
}

function modelErrorDetail(health: InstanceHealthSummary, model: string) {
  return [`model ${model} failed to load`, ...lastLogErrors(health)].join("\n");
}

function processErrorDetail(health: InstanceHealthSummary) {
  const detail = [health.reason, ...lastLogErrors(health)]
    .filter(Boolean)
    .join("\n");
  return detail || null;
}

type DerivedState = {
  state: ApiProxyModelState;
  activeRequests: number;
  detail: string | null;
};

function stateFromHealth(
  target: ApiProxyTargetRecord,
  health: InstanceHealthSummary,
): DerivedState {
  if (target.model) {
    const slots = modelScopedSlots(health, target.model);
    const activeRequests = activeRequestsFromSlots(slots);
    const state = modelRuntimeState(
      modelStatusFromProbe(health.probe.models, target.model),
    );
    return {
      state,
      activeRequests,
      detail: state === "error" ? modelErrorDetail(health, target.model) : null,
    };
  }

  const activeRequests = activeRequestsFromSlots(health.probe.llama?.slots);
  const state = processRuntimeState(health);
  return {
    state,
    activeRequests,
    detail: state === "error" ? processErrorDetail(health) : null,
  };
}

function baseState(input: {
  target: ApiProxyTargetRecord;
  instanceId: string | null;
  instance: Instance | undefined;
  health: InstanceHealthSummary | undefined;
}): DerivedState {
  if (!input.instanceId) {
    return { state: "ready", activeRequests: 0, detail: null };
  }
  if (!input.instance) {
    return {
      state: "error",
      activeRequests: 0,
      detail: `managed instance ${input.instanceId} not found`,
    };
  }
  if (!input.health) {
    return { state: "unknown", activeRequests: 0, detail: null };
  }
  return stateFromHealth(input.target, input.health);
}

function remoteDerivedState(
  target: ApiProxyTargetRecord,
  health: InstanceHealthSummary | undefined,
  inFlight: boolean,
): DerivedState {
  if (!health) {
    return { state: "unknown", activeRequests: 0, detail: null };
  }
  if (health.status === "error" || health.status === "invalid") {
    return {
      state: "error",
      activeRequests: 0,
      detail: processErrorDetail(health),
    };
  }
  const base = stateFromHealth(target, health);
  if (inFlight && stateIsIdle(base.state)) {
    return {
      state: base.state,
      activeRequests: Math.max(base.activeRequests, 1),
      detail: null,
    };
  }
  return base;
}

function deriveState(input: {
  target: ApiProxyTargetRecord;
  instanceId: string | null;
  instance: Instance | undefined;
  health: InstanceHealthSummary | undefined;
  inFlight: boolean;
}): DerivedState {
  const base = baseState(input);
  if (input.inFlight && stateIsIdle(base.state)) {
    return {
      state: base.state,
      activeRequests: Math.max(base.activeRequests, 1),
      detail: null,
    };
  }
  return base;
}

function trackerFor(targetId: string) {
  const existing = runtimeTrackers.get(targetId);
  if (existing) {
    return existing;
  }

  const created: RuntimeTracker = {
    idleSince: null,
    lastRequestAt: null,
    savedSlotIds: [],
  };
  runtimeTrackers.set(targetId, created);
  return created;
}

function stateIsIdle(state: ApiProxyModelState) {
  return state === "ready";
}

function updateTracker(input: {
  targetId: string;
  state: ApiProxyModelState;
  activeRequests: number;
  checkedAt: string;
  metadata?: ApiProxyRuntimeMetadataRecord | undefined;
}) {
  const tracker = trackerFor(input.targetId);
  if (input.metadata) {
    tracker.savedSlotIds = input.metadata.savedSlotIds;
  }

  if (input.activeRequests > 0) {
    if (tracker.idleSince !== null || tracker.lastRequestAt === null) {
      tracker.lastRequestAt = input.checkedAt;
    }
    tracker.idleSince = null;
    return tracker;
  }

  if (stateIsIdle(input.state)) {
    tracker.idleSince ??= input.checkedAt;
    return tracker;
  }

  tracker.idleSince = null;
  return tracker;
}

function deriveApiProxyTargetRuntime(input: {
  target: ApiProxyTargetRecord;
  kind: "managed-instance" | "external-api";
  endpointId: string;
  baseUrl: string;
  endpointEnabled: boolean;
  resolutionError?: string | null | undefined;
  instanceId: string | null;
  instance?: Instance | undefined;
  health?: InstanceHealthSummary | undefined;
  remoteManaged?: boolean | undefined;
  remoteHealth?: InstanceHealthSummary | undefined;
  metadata?: ApiProxyRuntimeMetadataRecord | undefined;
  inFlight?: boolean | undefined;
  inflight?: ApiProxyInflightRequest[] | undefined;
  router: boolean;
  slotPool: TargetSlotPool;
  checkedAt: string;
}): ApiProxyTargetRuntime {
  const inflight = input.endpointEnabled ? (input.inflight ?? []) : [];
  const activeInflight = inflight.filter(
    (request) => !apiProxyInflightPhaseEnded(request.phase),
  );
  const inFlight = (input.inFlight ?? false) || activeInflight.length > 0;
  const derived: DerivedState = !input.endpointEnabled
    ? {
        state: "error",
        activeRequests: 0,
        detail: input.resolutionError ?? "endpoint disabled",
      }
    : input.remoteManaged
      ? remoteDerivedState(input.target, input.remoteHealth, inFlight)
      : deriveState({
          target: input.target,
          instanceId: input.instanceId,
          instance: input.instance,
          health: input.health,
          inFlight,
        });
  const activeRequests = Math.max(
    derived.activeRequests,
    activeInflight.length,
  );
  const tracker = updateTracker({
    targetId: input.target.id,
    state: derived.state,
    activeRequests,
    checkedAt: input.checkedAt,
    metadata: input.metadata,
  });
  const slots = apiProxyTargetSlotAvailability({
    state: derived.state,
    instance: input.instance,
    health: input.remoteManaged ? input.remoteHealth : input.health,
    model: input.target.model,
    router: input.router,
    pool: input.slotPool,
  });

  return {
    targetId: input.target.id,
    kind: input.kind,
    endpointId: input.endpointId,
    baseUrl: input.baseUrl,
    instanceId: input.instanceId,
    model: input.target.model,
    state: derived.state,
    stateDetail: derived.detail,
    activeRequests,
    ...slots,
    idleSince: tracker.idleSince,
    lastRequestAt: tracker.lastRequestAt,
    savedSlotIds: tracker.savedSlotIds,
    inflight,
  };
}

export function buildApiProxyRuntimeSnapshot(input: {
  checkedAt: string;
  targets: ApiProxyTargetRecord[];
  endpoints: ApiEndpointRecord[];
  instances: Instance[];
  healthByInstanceId: Map<string, InstanceHealthSummary>;
  remoteManagedTargetIds?: Set<string> | undefined;
  remoteHealthByTargetId?: Map<string, InstanceHealthSummary> | undefined;
  metadataByTargetId?: Map<string, ApiProxyRuntimeMetadataRecord> | undefined;
  busyTargetIds?: Set<string> | undefined;
  inflightByTargetId?: Map<string, ApiProxyInflightRequest[]> | undefined;
  recentSlotActivity?: ApiProxySlotActivity[] | undefined;
  continuationHoldTargetIds?: string[] | undefined;
}): ApiProxyRuntimeSnapshot {
  const contexts = input.targets.map((target) => {
    const resolution = resolveApiProxyTarget(
      target,
      input.instances,
      input.endpoints,
    );
    const instance = resolution.instance ?? undefined;
    const health = resolution.instanceId
      ? input.healthByInstanceId.get(resolution.instanceId)
      : undefined;
    const remoteManaged = input.remoteManagedTargetIds?.has(target.id) ?? false;
    const remoteHealth = input.remoteHealthByTargetId?.get(target.id);
    const router = isRouterUpstream(
      instance,
      remoteManaged ? remoteHealth : health,
    );
    return {
      target,
      resolution,
      instance,
      health,
      remoteManaged,
      remoteHealth,
      router,
    };
  });
  const slotPools = targetSlotPools({
    members: contexts.map(({ target, router }) => ({
      targetId: target.id,
      endpointId: target.endpointId,
      model: target.model,
      router,
    })),
    inflightByTargetId: input.inflightByTargetId ?? new Map(),
    busyTargetIds: input.busyTargetIds ?? new Set(),
    recentSlotActivity: input.recentSlotActivity ?? [],
    continuationHoldTargetIds: input.continuationHoldTargetIds ?? [],
  });
  const activeTargetIds = new Set(input.targets.map((target) => target.id));
  for (const targetId of runtimeTrackers.keys()) {
    if (!activeTargetIds.has(targetId)) {
      runtimeTrackers.delete(targetId);
    }
  }

  return {
    checkedAt: input.checkedAt,
    targets: contexts.map(({ target, resolution, ...context }) =>
      deriveApiProxyTargetRuntime({
        target,
        kind: resolution.kind,
        endpointId: resolution.endpointId,
        baseUrl: resolution.baseUrl,
        endpointEnabled: resolution.enabled,
        resolutionError: resolution.error,
        instanceId: resolution.instanceId,
        instance: context.instance,
        health: context.health,
        remoteManaged: context.remoteManaged,
        remoteHealth: context.remoteHealth,
        metadata: input.metadataByTargetId?.get(target.id),
        inFlight: input.busyTargetIds?.has(target.id) ?? false,
        inflight: input.inflightByTargetId?.get(target.id),
        router: context.router,
        slotPool: slotPools.get(target.id)!,
        checkedAt: input.checkedAt,
      }),
    ),
  };
}

export function resetApiProxyRuntimeTrackers() {
  runtimeTrackers.clear();
}

export function setApiProxySavedSlotIds(
  targetId: string,
  savedSlotIds: number[],
) {
  trackerFor(targetId).savedSlotIds = savedSlotIds;
}
