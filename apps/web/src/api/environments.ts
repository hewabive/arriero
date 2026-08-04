import type {
  EnvironmentCreate,
  EnvironmentEngine,
  EnvironmentIndexVersions,
  EnvironmentJob,
  EnvironmentLogTail,
  EnvironmentRecord,
  EnvironmentRepositorySettings,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

type EnvironmentJobStartResult = {
  environment: EnvironmentRecord;
  job: EnvironmentJob;
};

export function listEnvironments() {
  return request<{ data: EnvironmentRecord[] }>("/api/environments");
}

export function getEnvironmentRepositorySettings() {
  return request<{ data: EnvironmentRepositorySettings }>(
    "/api/environments/settings",
  );
}

export function updateEnvironmentRepositorySettings(
  input: EnvironmentRepositorySettings,
) {
  return request<{ data: EnvironmentRepositorySettings }>(
    "/api/environments/settings",
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function createEnvironment(input: EnvironmentCreate) {
  return request<{ data: EnvironmentJobStartResult }>("/api/environments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function rebuildEnvironment(id: string) {
  return request<{ data: EnvironmentJobStartResult }>(
    `/api/environments/${id}/rebuild`,
    { method: "POST" },
  );
}

export function deleteEnvironment(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/environments/${id}`, {
    method: "DELETE",
  });
}

export function listEnvironmentIndexVersions(
  engine: EnvironmentEngine,
  pythonVersion?: string | null,
) {
  const query = new URLSearchParams({ engine });
  if (pythonVersion) query.set("pythonVersion", pythonVersion);
  return request<{ data: EnvironmentIndexVersions }>(
    `/api/environments/index-versions?${query.toString()}`,
  );
}

export function listEnvironmentJobs(limit = 20) {
  return request<{ data: EnvironmentJob[] }>(
    `/api/environments/jobs?limit=${limit}`,
  );
}

export function cancelEnvironmentJob(id: string) {
  return request<{ data: EnvironmentJob }>(
    `/api/environments/jobs/${id}/cancel`,
    { method: "POST" },
  );
}

export function getEnvironmentJobLogs(id: string, lines = 200) {
  return request<{ data: EnvironmentLogTail }>(
    `/api/environments/jobs/${id}/logs?lines=${lines}`,
  );
}
