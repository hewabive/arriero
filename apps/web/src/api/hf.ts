import {
  encodeHfPathSegments,
  type HfDestCheck,
  type HfDownloadDelete,
  type HfDownloadJob,
  type HfDownloadStart,
  type HfDownloadedRepo,
  type HfRepoBrowse,
  type HfTokenStatus,
  type HfUpdateCheck,
} from "@arriero/core";

import { buildQuery, nodeRequest as request } from "./http.js";

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
  return request<{ data: HfDownloadJob }>("/api/hf/downloads", {
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

export function listHfDownloadJobs() {
  return request<{ data: HfDownloadJob[] }>("/api/hf/jobs");
}

export function cancelHfDownloadJob(repoId: string) {
  return request<{ data: HfDownloadJob }>(
    `/api/hf/jobs/${encodeHfPathSegments(repoId)}/cancel`,
    { method: "POST" },
  );
}
