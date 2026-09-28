import type {
  AppRestartResult,
  AppVersion,
  UpdateFleet,
  UpdateJob,
  UpdateLogTail,
} from "@arriero/core";

import { requestOn, selfRequest } from "./http.js";

export async function getSelfVersion() {
  return selfRequest<{ data: AppVersion }>("/api/version");
}

export async function getUpdateFleet() {
  return selfRequest<{ data: UpdateFleet }>("/api/update/fleet");
}

export async function checkForUpdate() {
  return selfRequest<{ data: AppVersion; fetchError: string | null }>(
    "/api/update/check",
    { method: "POST" },
  );
}

export async function getNodeVersion(nodeId: string) {
  return requestOn<{ data: AppVersion }>(nodeId, "/api/version");
}

export async function restartNode(nodeId: string) {
  return requestOn<{ data: AppRestartResult }>(nodeId, "/api/update/restart", {
    method: "POST",
  });
}

export async function startNodeUpdate(nodeId: string, restart: boolean) {
  return requestOn<{ data: UpdateJob }>(nodeId, "/api/update", {
    method: "POST",
    body: JSON.stringify({ restart }),
  });
}

export async function getNodeUpdateJob(nodeId: string, id: string) {
  return requestOn<{ data: UpdateJob }>(nodeId, `/api/update/jobs/${id}`);
}

export async function cancelNodeUpdateJob(nodeId: string, id: string) {
  return requestOn<{ data: UpdateJob }>(
    nodeId,
    `/api/update/jobs/${id}/cancel`,
    { method: "POST" },
  );
}

export async function getNodeUpdateJobLogs(
  nodeId: string,
  id: string,
  lines = 300,
) {
  return requestOn<{ data: UpdateLogTail }>(
    nodeId,
    `/api/update/jobs/${id}/logs?lines=${lines}`,
  );
}
