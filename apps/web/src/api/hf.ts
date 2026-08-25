import type {
  HfDestCheck,
  HfDownloadDelete,
  HfDownloadQueueJob,
  HfDownloadQueueState,
  HfDownloadSettings,
  HfDownloadStart,
  HfDownloadedRepo,
  HfRepoBrowse,
  HfTokenStatus,
  HfUpdateCheck,
  ModelRequirement,
  ModelRequirementCreate,
  ModelRequirementStatus,
} from "@arriero/core";

import { buildQuery, nodeRequest as request } from "./http.js";

export function listModelRequirements() {
  return request<{ data: ModelRequirementStatus[] }>("/api/hf/requirements");
}

export function createModelRequirement(input: ModelRequirementCreate) {
  return request<{ data: ModelRequirement }>("/api/hf/requirements", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteModelRequirement(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/hf/requirements/${id}`, {
    method: "DELETE",
  });
}

export function getHfTokenStatus() {
  return request<{ data: HfTokenStatus }>("/api/hf/token");
}

export function updateHfToken(token: string | null) {
  return request<{ data: HfTokenStatus }>("/api/hf/token", {
    method: "PUT",
    body: JSON.stringify({ token }),
  });
}

export function browseHfRepo(repo: string, revision?: string) {
  return request<{ data: HfRepoBrowse }>(
    `/api/hf/browse${buildQuery({ repo, revision })}`,
  );
}

export function getHfDestCheck(input: { dir?: string; repo?: string }) {
  return request<{ data: HfDestCheck }>(
    `/api/hf/dest-check${buildQuery(input)}`,
  );
}

export function listHfDownloads() {
  return request<{ data: HfDownloadedRepo[] }>("/api/hf/downloads");
}

export function startHfDownload(input: HfDownloadStart) {
  return request<{ data: HfDownloadQueueJob }>("/api/hf/downloads", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function checkHfUpdates(dirs: string[]) {
  return request<{ data: Record<string, HfUpdateCheck> }>(
    "/api/hf/downloads/check",
    { method: "POST", body: JSON.stringify({ dirs }) },
  );
}

export function deleteHfDownload(input: HfDownloadDelete) {
  return request<{ data: { deleted: boolean } }>("/api/hf/downloads/delete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getHfDownloadQueue() {
  return request<{ data: HfDownloadQueueState }>("/api/hf/queue");
}

export function cancelHfDownloadJob(jobId: string) {
  return request<{ data: HfDownloadQueueState }>(
    `/api/hf/queue/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export function pauseHfDownloadJob(jobId: string) {
  return request<{ data: HfDownloadQueueState }>(
    `/api/hf/queue/${encodeURIComponent(jobId)}/pause`,
    { method: "POST" },
  );
}

export function resumeHfDownloadJob(jobId: string, ignoreSlowEta = false) {
  return request<{ data: HfDownloadQueueState }>(
    `/api/hf/queue/${encodeURIComponent(jobId)}/resume`,
    { method: "POST", body: JSON.stringify({ ignoreSlowEta }) },
  );
}

export function removeHfDownloadJob(jobId: string) {
  return request<{ data: HfDownloadQueueState }>(
    `/api/hf/queue/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

export function reorderHfDownloadQueue(ids: string[]) {
  return request<{ data: HfDownloadQueueState }>("/api/hf/queue/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function skipHfDownloadFiles(jobId: string, paths: string[]) {
  return request<{ data: HfDownloadQueueState }>(
    `/api/hf/queue/${encodeURIComponent(jobId)}/files/skip`,
    { method: "POST", body: JSON.stringify({ paths }) },
  );
}

export function clearHfDownloadHistory() {
  return request<{ data: HfDownloadQueueState }>("/api/hf/queue/history", {
    method: "DELETE",
  });
}

export function getHfDownloadSettings() {
  return request<{ data: HfDownloadSettings }>("/api/hf/download-settings");
}

export function updateHfDownloadSettings(input: HfDownloadSettings) {
  return request<{ data: HfDownloadSettings }>("/api/hf/download-settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
