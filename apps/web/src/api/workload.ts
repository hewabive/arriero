import type {
  WorkloadIndexStatus,
  WorkloadLinkingReport,
  WorkloadProfile,
  WorkloadProfileQueryInput,
  WorkloadRankedWindow,
  WorkloadSessionDetail,
  WorkloadSessionListQueryInput,
  WorkloadSessionSummary,
  WorkloadWindowRankingQueryInput,
} from "@arriero/core";

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

export async function listWorkloadWindows(
  query: WorkloadWindowRankingQueryInput,
) {
  return request<{ data: WorkloadRankedWindow[] }>(
    `/api/workload/windows${queryOf(query)}`,
  );
}

export async function getWorkloadLinking(query: {
  from?: string;
  to?: string;
}) {
  return request<{ data: WorkloadLinkingReport }>(
    `/api/workload/linking${queryOf(query)}`,
  );
}
