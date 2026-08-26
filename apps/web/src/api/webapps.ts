import type {
  Webapp,
  WebappCreate,
  WebappLogTail,
  WebappPreflightIssue,
  WebappRunInfo,
  WebappRuntime,
  WebappUpdate,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export function listWebapps() {
  return request<{ data: Webapp[] }>("/api/webapps");
}

export function createWebapp(input: WebappCreate) {
  return request<{ data: Webapp }>("/api/webapps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateWebapp(name: string, input: WebappUpdate) {
  return request<{ data: Webapp }>(`/api/webapps/${name}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteWebapp(name: string, deleteProxySource: boolean) {
  const query = deleteProxySource ? "?deleteProxySource=true" : "";
  return request<{ data: { deleted: boolean } }>(
    `/api/webapps/${name}${query}`,
    { method: "DELETE" },
  );
}

export function startWebapp(name: string) {
  return request<{ data: unknown }>(`/api/webapps/${name}/start`, {
    method: "POST",
  });
}

export function stopWebapp(name: string) {
  return request<{ data: unknown }>(`/api/webapps/${name}/stop`, {
    method: "POST",
  });
}

export function restartWebapp(name: string) {
  return request<{ data: unknown }>(`/api/webapps/${name}/restart`, {
    method: "POST",
  });
}

export function getWebappRuntime(name: string) {
  return request<{ data: WebappRuntime }>(`/api/webapps/${name}/runtime`);
}

export function listWebappRuns(name: string, limit = 20) {
  return request<{ data: WebappRunInfo[] }>(
    `/api/webapps/${name}/runs?limit=${limit}`,
  );
}

export function getWebappPreflight(name: string) {
  return request<{ data: { issues: WebappPreflightIssue[] } }>(
    `/api/webapps/${name}/preflight`,
  );
}

export function getWebappLogs(
  name: string,
  lines = 200,
  source: "filtered" | "raw" = "filtered",
) {
  return request<{ data: WebappLogTail }>(
    `/api/webapps/${name}/logs?lines=${lines}&source=${source}`,
  );
}
