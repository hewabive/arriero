import type {
  MemoryEstimate,
  MemoryEstimateRequest,
  MemoryPoolDeclaration,
  MemoryPoolUpdate,
  MemoryPoolView,
  ResourceLedger,
  SystemResources,
} from "@arriero/core";

import { request, requestOn } from "./http.js";

export type ResourcesSnapshot = {
  pools: MemoryPoolView[];
  ledger: ResourceLedger;
  detected: SystemResources;
  undeclared: SystemResources["accelerators"];
};

export async function getResources() {
  return request<{ data: ResourcesSnapshot }>("/api/resources");
}

export async function updateMemoryPool(
  id: string,
  input: MemoryPoolUpdate,
  nodeId: string,
) {
  return requestOn<{ data: MemoryPoolDeclaration }>(
    nodeId,
    `/api/resources/pools/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function declareGpuPool(deviceRef: string, nodeId: string) {
  return requestOn<{ data: MemoryPoolDeclaration }>(
    nodeId,
    "/api/resources/pools",
    {
      method: "POST",
      body: JSON.stringify({ deviceRef }),
    },
  );
}

export async function deleteMemoryPool(id: string, nodeId: string) {
  return requestOn<{ data: { deleted: string } }>(
    nodeId,
    `/api/resources/pools/${id}`,
    { method: "DELETE" },
  );
}

export async function estimateInstanceMemory(input: MemoryEstimateRequest) {
  return request<{
    data: {
      modelPath: string;
      estimate: MemoryEstimate;
      assessmentId: string | null;
    };
  }>("/api/memory-estimate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
