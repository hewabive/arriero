import type { BackgroundJobStatus } from "@arriero/core";

export function backgroundJobStatusColor(status: BackgroundJobStatus): string {
  if (status === "succeeded") return "green";
  if (status === "running") return "blue";
  if (status === "canceled") return "gray";
  return "red";
}
