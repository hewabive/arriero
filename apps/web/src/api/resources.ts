import type {
  MemoryEstimate,
  MemoryEstimateRequest,
  MemoryPool,
  MemoryPoolUpdate,
  MemoryPoolView,
  ResourceLedger,
  SystemResources,
} from "@arriero/core";

import { nodeScopedPath } from "./base.js";
import { nodeRequest, request } from "./http.js";

export type ResourcesSnapshot = {
  pools: MemoryPoolView[];
  ledger: ResourceLedger;
  detected: SystemResources;
};

export async function getResources() {
  return nodeRequest<{ data: ResourcesSnapshot }>("/api/resources");
}

export async function updateMemoryPool(
  id: string,
  input: MemoryPoolUpdate,
  nodeId?: string,
) {
  return request<{ data: MemoryPool }>(
    nodeScopedPath(nodeId, `/api/resources/pools/${id}`),
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteMemoryPool(id: string, nodeId?: string) {
  return request<{ data: { deleted: string } }>(
    nodeScopedPath(nodeId, `/api/resources/pools/${id}`),
    { method: "DELETE" },
  );
}

export async function estimateInstanceMemory(input: MemoryEstimateRequest) {
  return nodeRequest<{
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
