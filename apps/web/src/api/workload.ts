import type {
  WorkloadDatasetDetail,
  WorkloadDatasetFreezeRequestInput,
  WorkloadDatasetImportResult,
  WorkloadDatasetSelectionInput,
  WorkloadDatasetSummary,
  WorkloadFreezeJob,
  WorkloadIndexStatus,
  WorkloadLinkingQueryInput,
  WorkloadLinkingReport,
  WorkloadProfile,
  WorkloadProfileQueryInput,
  WorkloadSelectionPreview,
  WorkloadSessionDetail,
  WorkloadSessionListQueryInput,
  WorkloadSessionSummary,
} from "@arriero/core";

import { absoluteUrl, activeNodeScopedPath } from "./base.js";
import { buildQuery, nodeRequest as request } from "./http.js";

function queryOf(query: Record<string, unknown>): string {
  const params: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    params[key] =
      value === undefined || value === null ? undefined : String(value);
  }
  return buildQuery(params);
}

export async function getWorkloadIndexStatus() {
  return request<{ data: WorkloadIndexStatus }>("/api/workload/index");
}

export async function listWorkloadSessions(
  query: WorkloadSessionListQueryInput,
) {
  return request<{ data: WorkloadSessionSummary[] }>(
    `/api/workload/sessions${queryOf(query)}`,
  );
}

export async function getWorkloadSession(sessionId: string) {
  return request<{ data: WorkloadSessionDetail }>(
    `/api/workload/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function getWorkloadProfile(query: WorkloadProfileQueryInput) {
  return request<{ data: WorkloadProfile }>(
    `/api/workload/profile${queryOf(query)}`,
  );
}

export async function getWorkloadLinking(query: WorkloadLinkingQueryInput) {
  return request<{ data: WorkloadLinkingReport }>(
    `/api/workload/linking${queryOf(query)}`,
  );
}

export async function previewWorkloadSelection(
  selection: WorkloadDatasetSelectionInput,
) {
  return request<{ data: WorkloadSelectionPreview }>(
    "/api/workload/selection",
    { method: "POST", body: JSON.stringify(selection) },
  );
}

export async function freezeWorkloadDataset(
  input: WorkloadDatasetFreezeRequestInput,
) {
  return request<{ data: WorkloadFreezeJob }>("/api/workload/datasets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getWorkloadFreezeJob() {
  return request<{ data: WorkloadFreezeJob | null }>(
    "/api/workload/datasets/freeze",
  );
}

export async function listWorkloadDatasets() {
  return request<{ data: WorkloadDatasetSummary[] }>("/api/workload/datasets");
}

export async function getWorkloadDataset(id: string) {
  return request<{ data: WorkloadDatasetDetail }>(
    `/api/workload/datasets/${encodeURIComponent(id)}`,
  );
}

export async function deleteWorkloadDataset(id: string) {
  return request<{ data: { deleted: boolean } }>(
    `/api/workload/datasets/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function importWorkloadDataset(file: File) {
  return request<{ data: WorkloadDatasetImportResult }>(
    "/api/workload/datasets/import",
    {
      method: "POST",
      body: file,
      headers: { "content-type": "application/gzip" },
    },
  );
}

export function workloadDatasetExportUrl(id: string): string {
  return absoluteUrl(
    activeNodeScopedPath(
      `/api/workload/datasets/${encodeURIComponent(id)}/export`,
    ),
  );
}
