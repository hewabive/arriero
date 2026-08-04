import type {
  Instance,
  InstanceBulkActionRequest,
  InstanceBulkActionResult,
  InstanceCreate,
  InstanceHealthSummary,
  InstancePreflightPreview,
  InstanceResourceProfile,
  InstanceUpdate,
  ProcessPreflightResult,
  RpcWorkerCandidate,
  RuntimeState,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function listRpcWorkerCandidates() {
  return request<{ data: RpcWorkerCandidate[] }>("/api/fleet/rpc-workers");
}

export async function startRpcWorker(ref: {
  nodeId: string | null;
  instanceName: string;
}) {
  const path =
    ref.nodeId === null
      ? `/api/instances/${ref.instanceName}/start`
      : `/api/nodes/${ref.nodeId}/instances/${ref.instanceName}/start`;
  return request<{ data: unknown }>(path, {
    method: "POST",
    body: JSON.stringify({ force: false }),
  });
}

export async function createInstance(input: InstanceCreate) {
  return request<{ data: Instance }>("/api/instances", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function previewInstancePreflight(
  input: InstancePreflightPreview,
  signal?: AbortSignal,
) {
  return request<{ data: ProcessPreflightResult }>("/api/instances/preflight", {
    method: "POST",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

export async function updateInstance(id: string, input: InstanceUpdate) {
  return request<{ data: Instance }>(`/api/instances/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function instanceAction(
  id: string,
  action: "start" | "stop" | "restart",
  force = false,
) {
  return request<{ data: unknown }>(`/api/instances/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export async function startInstance(id: string, force = false) {
  return request<{ data: unknown }>(`/api/instances/${id}/start`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export async function bulkInstanceAction(input: InstanceBulkActionRequest) {
  return request<{ data: InstanceBulkActionResult }>("/api/instances/actions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteInstance(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/instances/${id}`, {
    method: "DELETE",
  });
}

export async function getRuntime(id: string) {
  return request<{ data: RuntimeState }>(`/api/instances/${id}/runtime`);
}

export async function getInstancePreflight(id: string) {
  return request<{ data: ProcessPreflightResult }>(
    `/api/instances/${id}/preflight`,
  );
}

export async function getInstanceHealthSummary(id: string) {
  return request<{ data: InstanceHealthSummary }>(
    `/api/instances/${id}/health-summary`,
  );
}

export async function bindInstanceMemoryAssessment(
  id: string,
  assessmentId: string,
) {
  return request<{ data: InstanceHealthSummary["memoryAssessment"] }>(
    `/api/instances/${id}/memory-assessment`,
    {
      method: "POST",
      body: JSON.stringify({ assessmentId }),
    },
  );
}

export async function getInstanceMemoryAssessmentReport(id: string) {
  return request<{ data: Record<string, unknown> }>(
    `/api/instances/${id}/memory-assessment/report`,
  );
}

export async function getInstanceResourceProfiles() {
  return request<{ data: Record<string, InstanceResourceProfile> }>(
    "/api/instances/resource-profiles",
  );
}
