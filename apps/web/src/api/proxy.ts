import type {
  ApiEndpointCreate,
  ApiEndpointRecord,
  ApiEndpointUpdate,
  ApiProxyConfig,
  ApiProxyModelCreate,
  ApiProxyModelRecord,
  ApiProxyModelUpdate,
  ApiProxyPlanPreview,
  ApiProxyPlanPreviewRequest,
  ApiProxyPipelineCreate,
  ApiProxyPipelineRecord,
  ApiProxyPipelineUpdate,
  ApiProxyQuickRouteCreate,
  ApiProxyQuickRouteResult,
  ApiProxyRouteExplainRequest,
  ApiProxyRouteExplainResult,
  ApiProxyRequestFileRecord,
  ApiProxyRequestTrace,
  ApiProxySourceCreate,
  ApiProxySourceRecord,
  ApiProxySourceUpdate,
  ApiProxyInflightDetail,
  ApiProxyInflightInterruptResult,
  ApiProxyInflightStopResult,
  ApiProxyRuntimeSnapshot,
  ApiProxyStatsSnapshot,
  ApiProxyTraceFacets,
  ApiProxyTargetModelCatalog,
  ApiProxyTargetCreate,
  ApiProxyTargetRecord,
  ApiProxyTargetUpdate,
  ExternalLlamaProcessesResult,
  ExternalProcessKillResult,
} from "@arriero/core";

import { nodeRequest, request } from "./http.js";

export async function getApiProxyConfig() {
  return request<{ data: ApiProxyConfig }>("/api/proxy/config");
}

export async function getActiveNodeApiProxyConfig() {
  return nodeRequest<{ data: ApiProxyConfig }>("/api/proxy/config");
}

export async function getApiProxyTargetModels(includeManagerProxy = false) {
  const query = includeManagerProxy ? "?includeManagerProxy=1" : "";
  return request<{ data: ApiProxyTargetModelCatalog }>(
    `/api/proxy/target-models${query}`,
  );
}

export async function listRemoteEndpoints() {
  return request<{ data: ApiEndpointRecord[] }>("/api/proxy/remote-endpoints");
}

export async function createApiEndpoint(input: ApiEndpointCreate) {
  return request<{ data: ApiEndpointRecord }>("/api/endpoints", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateApiEndpoint(id: string, input: ApiEndpointUpdate) {
  return request<{ data: ApiEndpointRecord }>(`/api/endpoints/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteApiEndpoint(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/endpoints/${id}`, {
    method: "DELETE",
  });
}

export async function listApiProxySources() {
  return request<{ data: ApiProxySourceRecord[] }>("/api/proxy/sources");
}

export async function createApiProxySource(input: ApiProxySourceCreate) {
  return request<{ data: ApiProxySourceRecord }>("/api/proxy/sources", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateApiProxySource(
  id: string,
  input: ApiProxySourceUpdate,
) {
  return request<{ data: ApiProxySourceRecord }>(`/api/proxy/sources/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteApiProxySource(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/proxy/sources/${id}`, {
    method: "DELETE",
  });
}

export async function getApiProxyRuntime() {
  return request<{ data: ApiProxyRuntimeSnapshot }>("/api/proxy/runtime");
}

export async function getApiProxyInflightDetail(id: string) {
  return request<{ data: ApiProxyInflightDetail }>(
    `/api/proxy/inflight/${encodeURIComponent(id)}`,
  );
}

export async function interruptApiProxyInflight(id: string) {
  return request<{ data: ApiProxyInflightInterruptResult }>(
    `/api/proxy/inflight/${encodeURIComponent(id)}/interrupt`,
    { method: "POST" },
  );
}

export async function finishApiProxyInflight(id: string) {
  return request<{ data: ApiProxyInflightStopResult }>(
    `/api/proxy/inflight/${encodeURIComponent(id)}/finish`,
    { method: "POST" },
  );
}

export async function cancelApiProxyInflight(id: string) {
  return request<{ data: ApiProxyInflightStopResult }>(
    `/api/proxy/inflight/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
}

export async function getApiProxyStats(hours = 24) {
  const params = new URLSearchParams({ hours: String(hours) });
  return request<{ data: ApiProxyStatsSnapshot }>(
    `/api/proxy/stats?${params.toString()}`,
  );
}

export async function getApiProxyTraces(limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  return request<{ data: ApiProxyRequestTrace[] }>(
    `/api/proxy/traces?${params.toString()}`,
  );
}

export type ApiProxyTraceHistoryQuery = {
  limit?: number;
  before?: string;
  from?: string;
  to?: string;
  protocol?: string;
  endpoint?: string;
  modelId?: string;
  sourceId?: string;
  targetId?: string;
  ok?: boolean;
  status?: number;
  errorCode?: string;
  cache?: string;
  resumed?: boolean;
  stream?: boolean;
  translated?: boolean;
  minDurationMs?: number;
};

export async function listApiProxyTraceHistory(
  query: ApiProxyTraceHistoryQuery,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return request<{ data: ApiProxyRequestTrace[]; total: number }>(
    `/api/proxy/traces?${params.toString()}`,
  );
}

export async function getApiProxyTraceFacets() {
  return request<{ data: ApiProxyTraceFacets }>("/api/proxy/traces/facets");
}

export async function getApiProxyCacheStats() {
  return request<{ data: { entries: number; totalBytes: number } }>(
    "/api/proxy/cache",
  );
}

export async function clearApiProxyCache() {
  return request<{ data: { cleared: boolean } }>("/api/proxy/cache", {
    method: "DELETE",
  });
}

export async function getApiProxyRequestFile(path: string) {
  const params = new URLSearchParams({ path });
  return request<{ data: ApiProxyRequestFileRecord }>(
    `/api/proxy/request-file?${params.toString()}`,
  );
}

export async function previewApiProxyPlan(input: ApiProxyPlanPreviewRequest) {
  return request<{ data: ApiProxyPlanPreview }>("/api/proxy/plan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createApiProxyModel(input: ApiProxyModelCreate) {
  return request<{ data: ApiProxyModelRecord }>("/api/proxy/models", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateApiProxyModel(
  id: string,
  input: ApiProxyModelUpdate,
) {
  return request<{ data: ApiProxyModelRecord }>(`/api/proxy/models/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteApiProxyModel(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/proxy/models/${id}`, {
    method: "DELETE",
  });
}

export async function createApiProxyPipeline(input: ApiProxyPipelineCreate) {
  return request<{ data: ApiProxyPipelineRecord }>("/api/proxy/pipelines", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateApiProxyPipeline(
  id: string,
  input: ApiProxyPipelineUpdate,
) {
  return request<{ data: ApiProxyPipelineRecord }>(
    `/api/proxy/pipelines/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteApiProxyPipeline(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/proxy/pipelines/${id}`, {
    method: "DELETE",
  });
}

export async function explainApiProxyRoute(input: ApiProxyRouteExplainRequest) {
  return request<{ data: ApiProxyRouteExplainResult }>(
    "/api/proxy/route-explain",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function createApiProxyQuickRoute(
  input: ApiProxyQuickRouteCreate,
) {
  return request<{ data: ApiProxyQuickRouteResult }>("/api/proxy/quick-route", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createApiProxyTarget(input: ApiProxyTargetCreate) {
  return request<{ data: ApiProxyTargetRecord }>("/api/proxy/targets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateApiProxyTarget(
  id: string,
  input: ApiProxyTargetUpdate,
) {
  return request<{ data: ApiProxyTargetRecord }>(`/api/proxy/targets/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteApiProxyTarget(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/proxy/targets/${id}`, {
    method: "DELETE",
  });
}

export async function listExternalLlamaProcesses() {
  return request<{ data: ExternalLlamaProcessesResult }>(
    "/api/system/llama-processes",
  );
}

export async function killExternalLlamaProcess(pid: number, force = false) {
  return request<{ data: ExternalProcessKillResult }>(
    `/api/system/llama-processes/${pid}/kill`,
    {
      method: "POST",
      body: JSON.stringify({ force }),
    },
  );
}
