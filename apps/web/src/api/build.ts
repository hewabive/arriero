import type {
  BuildJob,
  BuildJobStart,
  BuildLogTail,
  BuildSettings,
  LlamaSourcePullResult,
  LlamaSourceRefs,
  LlamaSourceStatus,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function getBuildSettings() {
  return request<{ data: BuildSettings }>("/api/build/settings");
}

export async function getDefaultLlamaServerBinary() {
  return request<{
    data: { path: string; refId: string | null; exists: boolean };
  }>("/api/build/default-binary");
}

export async function getLlamaSourceStatus() {
  return request<{ data: LlamaSourceStatus }>("/api/llama-source/status");
}

export async function getLlamaSourceRefs() {
  return request<{ data: LlamaSourceRefs }>("/api/llama-source/refs");
}

export async function checkoutLlamaSourceRef(ref: string) {
  return request<{ data: LlamaSourceStatus }>("/api/llama-source/checkout", {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
}

export async function pullLlamaSource() {
  return request<{ data: LlamaSourcePullResult }>("/api/llama-source/pull", {
    method: "POST",
  });
}

export async function updateBuildSettings(input: BuildSettings) {
  return request<{ data: BuildSettings }>("/api/build/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function listBuildJobs(limit = 20) {
  return request<{ data: BuildJob[] }>(`/api/build/jobs?limit=${limit}`);
}

export async function startBuildJob(input: BuildJobStart) {
  return request<{ data: BuildJob }>("/api/build/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelBuildJob(id: string) {
  return request<{ data: BuildJob }>(`/api/build/jobs/${id}/cancel`, {
    method: "POST",
  });
}

export async function getBuildJobLogs(id: string, lines = 200) {
  return request<{ data: BuildLogTail }>(
    `/api/build/jobs/${id}/logs?lines=${lines}`,
  );
}
