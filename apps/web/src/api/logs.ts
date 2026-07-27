import type { InstanceLogSummary, LogTail } from "@arriero/core";

import { activeNodeScopedPath, apiBase } from "./base.js";
import { nodeRequest as request } from "./http.js";

export async function getInstanceLogs(
  id: string,
  lines = 200,
  source: "filtered" | "raw" = "filtered",
) {
  return request<{ data: LogTail }>(
    `/api/instances/${id}/logs?lines=${lines}&source=${source}`,
  );
}

export async function getInstanceStatusSummary(id: string) {
  return request<{ data: InstanceLogSummary }>(
    `/api/instances/${id}/status-summary`,
  );
}

export function instanceEventsUrl(id: string) {
  return `${apiBase}${activeNodeScopedPath(`/api/instances/${id}/events`)}`;
}
