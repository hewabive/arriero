import type { InstanceHealthSummary } from "@arriero/core";

export type LaunchMonitor = {
  instanceId: string;
  startedAt: string;
  source: "create" | "start" | "restart";
};

export function isLaunchTerminalStatus(
  status: InstanceHealthSummary["status"] | undefined,
) {
  return (
    status === "ready" ||
    status === "error" ||
    status === "invalid" ||
    status === "stale" ||
    status === "stopped"
  );
}
