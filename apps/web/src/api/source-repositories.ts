import type {
  SourceRepositoryClone,
  SourceRepositoryOperationResult,
  SourceRepositorySettingsUpdate,
  SourceRepositoryStatus,
  SourceSyncReport,
} from "@llama-manager/core";

import { nodeRequest as request } from "./http.js";

function sourcePath(id: string, suffix = "") {
  return `/api/source-repositories/${encodeURIComponent(id)}${suffix}`;
}

export function listSourceRepositories() {
  return request<{ data: SourceRepositoryStatus[] }>(
    "/api/source-repositories",
  );
}

export function getSourceRepositoryDrift(id: string) {
  return request<{ data: SourceSyncReport }>(sourcePath(id, "/drift"));
}

export function cloneSourceRepository(
  id: string,
  input: SourceRepositoryClone,
) {
  return request<{ data: SourceRepositoryOperationResult }>(
    sourcePath(id, "/clone"),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function updateSourceRepositorySettings(
  id: string,
  input: SourceRepositorySettingsUpdate,
) {
  return request<{ data: SourceRepositoryOperationResult }>(
    sourcePath(id, "/settings"),
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export function pullSourceRepository(id: string) {
  return request<{ data: SourceRepositoryOperationResult }>(
    sourcePath(id, "/pull"),
    { method: "POST" },
  );
}
