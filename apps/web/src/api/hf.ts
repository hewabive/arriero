import type { ModelLibraryAction, ModelLibrarySnapshot } from "@arriero/core";
import type { ModelImportSelection } from "@arriero/core";
import type { ModelImportRequest, ModelImportState } from "@arriero/core";
import type {
  HfDestCheck,
  HfDownloadDelete,
  HfDownloadIntegrity,
  HfDownloadQueueJob,
  HfDownloadQueueState,
  HfDownloadSettings,
  HfDownloadStart,
  HfDownloadedRepo,
  HfRepoBrowse,
  HfTokenStatus,
  ModelLibraryEntry,
  ModelLibraryEntryCreate,
  ModelLibraryEntryStatus,
} from "@arriero/core";

import { buildQuery, nodeRequest as request } from "./http.js";

export function listModelLibraryEntries() {
  return request<{ data: ModelLibraryEntryStatus[] }>("/api/hf/library");
}

export function createModelLibraryEntry(input: ModelLibraryEntryCreate) {
  return request<{ data: ModelLibraryEntry }>("/api/hf/library", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteModelLibraryEntry(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/hf/library/${id}`, {
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

export function checkHfDownloadIntegrity(dir: string) {
  return request<{ data: HfDownloadIntegrity }>("/api/hf/downloads/integrity", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
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

export function prepareModelImport(input: ModelImportRequest) {
  return request<{ data: ModelImportState }>("/api/hf/imports", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function getModelImport(id: string) {
  return request<{ data: ModelImportState }>(
    `/api/hf/imports/${encodeURIComponent(id)}`,
  );
}
export function commitModelImport(id: string) {
  return request<{ data: ModelImportState }>("/api/hf/imports/commit", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function listModelImports() {
  return request<{ data: ModelImportState[] }>("/api/hf/imports");
}
export function selectModelImport(input: ModelImportSelection) {
  return request<{ data: ModelImportState }>("/api/hf/imports/select", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function cancelModelImport(id: string) {
  return request<{ data: ModelImportState }>("/api/hf/imports/cancel", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function actOnModelLibraryEntry(id: string, action: ModelLibraryAction) {
  return request<{ data: boolean }>(`/api/hf/library/${id}/actions`, {
    method: "POST",
    body: JSON.stringify(action),
  });
}
export function getModelLibrarySnapshot(id: string) {
  return request<{ data: ModelLibrarySnapshot }>(
    `/api/hf/library/${id}/snapshot`,
  );
}
