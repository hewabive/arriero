import type {
  AppVersion,
  UpdateFleet,
  UpdateJob,
  UpdateLogTail,
} from "@llama-manager/core";

import { nodeScopedPath } from "./base.js";
import { request } from "./http.js";

export async function getUpdateFleet() {
  return request<{ data: UpdateFleet }>("/api/update/fleet");
}

export async function checkForUpdate() {
  return request<{ data: AppVersion; fetchError: string | null }>(
    "/api/update/check",
    { method: "POST" },
  );
}

export async function startNodeUpdate(nodeId: string, restart: boolean) {
  return request<{ data: UpdateJob }>(nodeScopedPath(nodeId, "/api/update"), {
    method: "POST",
    body: JSON.stringify({ restart }),
  });
}

export async function getNodeLatestUpdateJob(nodeId: string) {
  return request<{ data: UpdateJob | null }>(
    nodeScopedPath(nodeId, "/api/update/latest"),
  );
}

export async function getNodeUpdateJob(nodeId: string, id: string) {
  return request<{ data: UpdateJob }>(
    nodeScopedPath(nodeId, `/api/update/jobs/${id}`),
  );
}

export async function cancelNodeUpdateJob(nodeId: string, id: string) {
  return request<{ data: UpdateJob }>(
    nodeScopedPath(nodeId, `/api/update/jobs/${id}/cancel`),
    { method: "POST" },
  );
}

export async function getNodeUpdateJobLogs(
  nodeId: string,
  id: string,
  lines = 300,
) {
  return request<{ data: UpdateLogTail }>(
    nodeScopedPath(nodeId, `/api/update/jobs/${id}/logs?lines=${lines}`),
  );
}
