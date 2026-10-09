import {
  apiProxyInflightPhaseEnded,
  instanceEndpointId,
  isRouterInstance,
  type ApiProxyInflightRequest,
  type ApiProxyModelState,
  type ApiProxySlotAvailability,
  type EndpointProbe,
  type Instance,
  type InstanceHealthSummary,
} from "@arriero/core";

import { parseInstanceConcurrencyLimit } from "./domain-admission.js";
import type { ApiProxySlotActivity } from "./inflight.js";
import { asObject } from "./json.js";
import { apiProxyTargetInstanceName } from "./target-instance.js";

type SlotDemand = {
  active: number;
  queued: number;
  held: number;
  recentPeak: number;
};

const NO_SLOT_DEMAND: SlotDemand = {
  active: 0,
  queued: 0,
  held: 0,
  recentPeak: 0,
};

export const UNKNOWN_SLOT_AVAILABILITY: ApiProxySlotAvailability = {
  availableSlots: null,
  heldSlots: null,
  slotPool: null,
};

export type SlotPoolMember = {
  targetId: string;
  endpointId: string;
  model: string | null;
  router: boolean;
};

export type TargetSlotPool = { slotPool: string; demand: SlotDemand };

type SlotEvent = { at: number; delta: number };

type DemandTally = {
  requestIds: Set<string>;
  queued: number;
  untracked: number;
  held: number;
  events: SlotEvent[];
};

export function isRouterUpstream(
  instance: Instance | undefined,
  health: InstanceHealthSummary | undefined,
): boolean {
  const props = health?.probe.llama?.props;
  return (
    (instance !== undefined && isRouterInstance(instance)) ||
    (props?.ok === true && asObject(props.body)?.role === "router")
  );
}

function ephemeralInstanceKey(targetId: string): string | null {
  const instanceName = apiProxyTargetInstanceName(targetId, null);
  return instanceName ? instanceEndpointId(instanceName) : null;
}

function peakConcurrency(events: SlotEvent[]): number {
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function slotPoolResolver(members: SlotPoolMember[]) {
  const memberById = new Map(
    members.map((member) => [member.targetId, member]),
  );
  const modelPoolsByRouter = new Map(
    members
      .filter((member) => member.router)
      .map((member) => [member.endpointId, new Set<string>()]),
  );
  const poolOf = (endpointId: string, model: string | null) =>
    model !== null && modelPoolsByRouter.has(endpointId)
      ? `${endpointId}#${model}`
      : endpointId;
  for (const member of members) {
    if (member.model !== null) {
      modelPoolsByRouter
        .get(member.endpointId)
        ?.add(poolOf(member.endpointId, member.model));
    }
  }
  return {
    poolOf: (member: SlotPoolMember) => poolOf(member.endpointId, member.model),
    poolsOf: (targetId: string): string[] => {
      const member = memberById.get(targetId);
      const endpointId = member
        ? member.endpointId
        : ephemeralInstanceKey(targetId);
      if (endpointId === null) return [];
      const model = member?.model ?? null;
      const modelPools = modelPoolsByRouter.get(endpointId);
      return modelPools && model === null
        ? [endpointId, ...modelPools]
        : [poolOf(endpointId, model)];
    },
  };
}

export function targetSlotPools(input: {
  members: SlotPoolMember[];
  inflightByTargetId: Map<string, ApiProxyInflightRequest[]>;
  busyTargetIds: Set<string>;
  recentSlotActivity: ApiProxySlotActivity[];
  continuationHoldTargetIds: string[];
}): Map<string, TargetSlotPool> {
  const pools = slotPoolResolver(input.members);
  const tallies = new Map<string, DemandTally>();
  const talliesOf = (targetId: string): DemandTally[] =>
    pools.poolsOf(targetId).map((pool) => {
      const tally = tallies.get(pool) ?? {
        requestIds: new Set<string>(),
        queued: 0,
        untracked: 0,
        held: 0,
        events: [],
      };
      tallies.set(pool, tally);
      return tally;
    });
  for (const targetId of input.continuationHoldTargetIds) {
    for (const tally of talliesOf(targetId)) tally.held += 1;
  }
  for (const activity of input.recentSlotActivity) {
    for (const tally of talliesOf(activity.targetId)) {
      tally.events.push(
        { at: activity.startedAt, delta: 1 },
        { at: activity.endedAt, delta: -1 },
      );
    }
  }
  const liveTargetIds = new Set<string>();
  for (const [targetId, requests] of input.inflightByTargetId) {
    const live = requests.filter(
      (request) => !apiProxyInflightPhaseEnded(request.phase),
    );
    if (live.length > 0) liveTargetIds.add(targetId);
    for (const tally of talliesOf(targetId)) {
      for (const request of live) {
        if (tally.requestIds.has(request.id)) continue;
        tally.requestIds.add(request.id);
        if (request.phase === "queued") tally.queued += 1;
      }
    }
  }
  for (const targetId of input.busyTargetIds) {
    if (liveTargetIds.has(targetId)) continue;
    for (const tally of talliesOf(targetId)) tally.untracked += 1;
  }
  const demandByPool = new Map(
    [...tallies].map(([pool, tally]) => [
      pool,
      {
        active: tally.requestIds.size - tally.queued + tally.untracked,
        queued: tally.queued,
        held: tally.held,
        recentPeak: peakConcurrency(tally.events),
      },
    ]),
  );
  return new Map(
    input.members.map((member) => {
      const slotPool = pools.poolOf(member);
      return [
        member.targetId,
        { slotPool, demand: demandByPool.get(slotPool) ?? NO_SLOT_DEMAND },
      ];
    }),
  );
}

function measuredSlots(probe: EndpointProbe | undefined) {
  if (!probe?.ok || !Array.isArray(probe.body) || probe.body.length === 0) {
    return null;
  }
  const slots = probe.body.map(asObject);
  if (slots.some((slot) => typeof slot?.is_processing !== "boolean")) {
    return null;
  }
  return {
    total: slots.length,
    active: slots.filter((slot) => slot?.is_processing === true).length,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

type TargetSlotInput = {
  state: ApiProxyModelState;
  instance: Instance | undefined;
  health: InstanceHealthSummary | undefined;
  model: string | null;
  router: boolean;
  demand: SlotDemand;
};

function availableTargetSlots(input: TargetSlotInput): number | null {
  if (input.state === "unknown") return null;
  if (input.state !== "ready") return 0;
  const { instance, health, model, router, demand } = input;
  if (!health) return null;
  const llama = health.probe.llama;
  const probes = (model ? llama?.modelDiagnostics[model] : null) ?? llama;
  const props = probes?.props.ok ? asObject(probes.props.body) : null;
  if (props?.is_sleeping === true) return 0;
  const measured = measuredSlots(probes?.slots);
  const configuredLimit =
    instance && !health.configDrift && !router
      ? parseInstanceConcurrencyLimit(instance)
      : undefined;
  const limit =
    measured?.total ??
    positiveInteger(props?.total_slots) ??
    (llama && !model && !router ? health.logSummary.slots : null) ??
    configuredLimit;
  if (limit === undefined) return null;
  const active = Math.max(measured?.active ?? 0, demand.active);
  const committed = Math.max(
    active + demand.queued + demand.held,
    demand.recentPeak,
  );
  return Math.max(0, limit - committed);
}

export function apiProxyTargetSlotAvailability(
  input: Omit<TargetSlotInput, "demand"> & { pool: TargetSlotPool },
): ApiProxySlotAvailability {
  const availableSlots = availableTargetSlots({
    ...input,
    demand: input.pool.demand,
  });
  return availableSlots === null
    ? UNKNOWN_SLOT_AVAILABILITY
    : {
        availableSlots,
        heldSlots: input.pool.demand.held,
        slotPool: input.pool.slotPool,
      };
}
