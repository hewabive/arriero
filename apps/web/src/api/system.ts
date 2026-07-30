import type {
  FileSystemListResult,
  NetworkInterfacesResult,
  PathCatalogCreate,
  PathCatalogEntry,
  PathCatalogKind,
  PathCatalogUpdate,
  SystemMetricsHistory,
  SystemMetricsWindow,
  SystemResources,
} from "@arriero/core";

import { activeNodeScopedPath, apiBase } from "./base.js";
import { buildQuery, nodeRequest as request } from "./http.js";

export async function listNetworkInterfaces() {
  return request<{ data: NetworkInterfacesResult }>("/api/network/interfaces");
}

export async function getSystemResources() {
  return request<{ data: SystemResources }>("/api/system/resources");
}

export async function getSystemMetrics(window: SystemMetricsWindow) {
  return request<{ data: SystemMetricsHistory }>(
    `/api/system/metrics${buildQuery({ window })}`,
  );
}

export function systemMetricsStreamUrl() {
  return `${apiBase}${activeNodeScopedPath("/api/system/metrics/stream")}`;
}

export async function listFilesystemDirectory(path?: string) {
  const query = buildQuery({ path });
  return request<{ data: FileSystemListResult }>(
    `/api/filesystem/list${query}`,
  );
}

export async function listPathCatalog(kind?: PathCatalogKind) {
  const query = buildQuery({ kind });
  return request<{ data: PathCatalogEntry[] }>(`/api/path-catalog${query}`);
}

export async function createPathCatalogEntry(input: PathCatalogCreate) {
  return request<{ data: PathCatalogEntry }>("/api/path-catalog", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePathCatalogEntry(
  id: string,
  input: PathCatalogUpdate,
) {
  return request<{ data: PathCatalogEntry }>(`/api/path-catalog/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePathCatalogEntry(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/path-catalog/${id}`, {
    method: "DELETE",
  });
}
