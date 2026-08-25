import type {
  InstanceLogSummary,
  LogPruneResult,
  LogRetentionSettings,
  LogStorageUsage,
  LogTail,
} from "@arriero/core";

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

export async function getLogRetentionSettings() {
  return request<{ data: LogRetentionSettings }>("/api/logs/settings");
}

export async function updateLogRetentionSettings(input: LogRetentionSettings) {
  return request<{ data: LogRetentionSettings }>("/api/logs/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function getLogStorageUsage() {
  return request<{ data: LogStorageUsage }>("/api/logs/usage");
}

export async function pruneLogStorage() {
  return request<{ data: LogPruneResult }>("/api/logs/prune", {
    method: "POST",
  });
}
