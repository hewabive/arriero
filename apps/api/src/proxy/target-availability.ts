import {
  apiProxyInflightPhaseEnded,
  instanceEndpointId,
  instanceIdFromEndpointId,
  type ApiProxyInflightRequest,
  type ApiProxyModelState,
  type EndpointProbe,
  type Instance,
  type InstanceHealthSummary,
} from "@arriero/core";

import { parseInstanceConcurrencyLimit } from "./domain-admission.js";
import { externalTargetEndpointId } from "./external-target.js";
import type { ApiProxySlotActivity } from "./inflight.js";
import { asObject } from "./json.js";
import { serveTargetInstanceId } from "./serve-target-id.js";

export type InstanceRequestDemand = {
  active: number;
  queued: number;
  recentPeak: number;
};

function ephemeralInstanceKey(targetId: string): string | null {
  const endpointId = externalTargetEndpointId(targetId);
  const instanceId =
    serveTargetInstanceId(targetId) ??
    (endpointId ? instanceIdFromEndpointId(endpointId) : null);
  return instanceId ? instanceEndpointId(instanceId) : null;
}

export function instanceRequestDemand(input: {
  instanceKeyByTargetId: Map<string, string>;
  inflightByTargetId: Map<string, ApiProxyInflightRequest[]>;
  busyTargetIds: Set<string>;
  recentSlotActivity: ApiProxySlotActivity[];
}): Map<string, InstanceRequestDemand> {
  const requestsByInstance = new Map<
    string,
    Map<string, ApiProxyInflightRequest>
  >();
  const untrackedByInstance = new Map<string, number>();
  const activityByInstance = new Map<string, { at: number; delta: number }[]>();
  const instanceKey = (targetId: string) =>
    input.instanceKeyByTargetId.get(targetId) ?? ephemeralInstanceKey(targetId);
  for (const activity of input.recentSlotActivity) {
    const key = instanceKey(activity.targetId);
    if (!key) continue;
    const events = activityByInstance.get(key) ?? [];
    events.push(
      { at: activity.startedAt, delta: 1 },
      { at: activity.endedAt, delta: -1 },
    );
    activityByInstance.set(key, events);
  }
  const targetIds = new Set([
    ...input.inflightByTargetId.keys(),
    ...input.busyTargetIds,
    ...input.recentSlotActivity.map((activity) => activity.targetId),
  ]);
  for (const targetId of targetIds) {
    const key = instanceKey(targetId);
    if (!key) continue;
    const requests = (input.inflightByTargetId.get(targetId) ?? []).filter(
      (request) => !apiProxyInflightPhaseEnded(request.phase),
    );
    const grouped =
      requestsByInstance.get(key) ?? new Map<string, ApiProxyInflightRequest>();
    for (const request of requests) grouped.set(request.id, request);
    requestsByInstance.set(key, grouped);
    if (requests.length === 0 && input.busyTargetIds.has(targetId)) {
      untrackedByInstance.set(key, (untrackedByInstance.get(key) ?? 0) + 1);
    }
  }
  return new Map(
    [...requestsByInstance].map(([key, requests]) => {
      const queued = [...requests.values()].filter(
        (request) => request.phase === "queued",
      ).length;
      const events = activityByInstance.get(key) ?? [];
      events.sort((a, b) => a.at - b.at || a.delta - b.delta);
      let active = 0;
      let recentPeak = 0;
      for (const event of events) {
        active += event.delta;
        recentPeak = Math.max(recentPeak, active);
      }
      return [
        key,
        {
          active: requests.size - queued + (untrackedByInstance.get(key) ?? 0),
          queued,
          recentPeak,
        },
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

export function availableApiProxyTargetSlots(input: {
  state: ApiProxyModelState;
  instance: Instance | undefined;
  health: InstanceHealthSummary | undefined;
  model: string | null;
  demand: InstanceRequestDemand | undefined;
}): number | null {
  if (input.state === "unknown") return null;
  if (input.state !== "ready") return 0;
  const { instance, health, model } = input;
  if (!health) return null;
  const llama = health.probe.llama;
  const probes = (model ? llama?.modelDiagnostics[model] : null) ?? llama;
  const props = probes?.props.ok ? asObject(probes.props.body) : null;
  if (props?.is_sleeping === true) return 0;
  const measured = measuredSlots(probes?.slots);
  const router =
    props?.role === "router" || Boolean(instance?.args["--models-preset"]);
  const configuredLimit =
    instance && !health.configDrift && !router
      ? parseInstanceConcurrencyLimit(instance)
      : undefined;
  const limit =
    measured?.total ??
    positiveInteger(props?.total_slots) ??
    (llama && !model && !router
      ? positiveInteger(health.logSummary.slots)
      : null) ??
    configuredLimit;
  if (limit === undefined) return null;
  const active = Math.max(measured?.active ?? 0, input.demand?.active ?? 0);
  const demand = Math.max(
    active + (input.demand?.queued ?? 0),
    input.demand?.recentPeak ?? 0,
  );
  return Math.max(0, limit - demand);
}
