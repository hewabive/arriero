import type { Instance, InstanceHealthSummary } from "@arriero/core";

type EffectiveInstanceStatus =
  | InstanceHealthSummary["status"]
  | Instance["status"];

const RUNNING_STATUSES = new Set<EffectiveInstanceStatus>([
  "ready",
  "loading",
  "degraded",
  "starting",
  "running",
]);

function effectiveInstanceStatus(
  instance: Instance,
  health: InstanceHealthSummary | undefined,
): EffectiveInstanceStatus {
  return health?.status ?? instance.status;
}

export type InstanceStatusCounts = {
  total: number;
  running: number;
  stale: number;
  error: number;
  degraded: number;
  stopped: number;
};

export function countInstanceStatuses(
  instances: Instance[],
  healthByInstanceId: Map<string, InstanceHealthSummary>,
): InstanceStatusCounts {
  const statuses = instances.map((instance) =>
    effectiveInstanceStatus(instance, healthByInstanceId.get(instance.name)),
  );
  return {
    total: instances.length,
    running: statuses.filter((status) => RUNNING_STATUSES.has(status)).length,
    stale: statuses.filter((status) => status === "stale").length,
    error: statuses.filter(
      (status) => status === "error" || status === "invalid",
    ).length,
    degraded: statuses.filter((status) => status === "degraded").length,
    stopped: statuses.filter((status) => status === "stopped").length,
  };
}
