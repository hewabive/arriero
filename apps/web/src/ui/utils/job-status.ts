import type { BackgroundJobStatus, HfDownloadJobStatus } from "@arriero/core";

export function backgroundJobStatusColor(status: BackgroundJobStatus): string {
  if (status === "succeeded") return "green";
  if (status === "running") return "blue";
  if (status === "canceled") return "gray";
  return "red";
}

export function hfDownloadJobStatusColor(status: HfDownloadJobStatus): string {
  if (status === "queued") return "gray";
  if (status === "paused") return "yellow";
  return backgroundJobStatusColor(status);
}
