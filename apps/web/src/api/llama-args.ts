import type {
  ArgumentCatalog,
  ArgumentDefaults,
  LlamaArgumentDocsSyncReport,
  LlamaArgumentHelpDiff,
  LlamaArgumentEngineeringDoc,
  LlamaSourceSyncReport,
} from "@llama-manager/core";

import { buildQuery, nodeRequest as request } from "./http.js";

export async function getLlamaArguments(binaryPath?: string, refresh = false) {
  const query = buildQuery({
    binaryPath,
    refresh: refresh ? "true" : undefined,
  });
  return request<{ data: ArgumentCatalog }>(`/api/llama-args${query}`);
}

export async function getLlamaArgumentReference() {
  return request<{ data: ArgumentCatalog }>("/api/llama-args/reference");
}

export async function getLlamaArgumentDoc(primaryName: string) {
  const name = encodeURIComponent(primaryName);
  return request<{ data: LlamaArgumentEngineeringDoc }>(
    `/api/llama-args/docs/${name}`,
  );
}

export async function getLlamaArgumentDocsSyncReport() {
  return request<{ data: LlamaArgumentDocsSyncReport }>(
    "/api/llama-args/docs-sync",
  );
}

export async function getLlamaArgumentHelpDiff() {
  return request<{ data: LlamaArgumentHelpDiff }>(
    "/api/llama-args/docs-sync/diff",
  );
}

export async function getLlamaSourceSyncReport() {
  return request<{ data: LlamaSourceSyncReport }>("/api/llama-source/sync");
}

export async function getLlamaArgumentDefaults() {
  return request<{ data: ArgumentDefaults }>("/api/llama-args/defaults");
}

export async function updateLlamaArgumentDefaults(input: ArgumentDefaults) {
  return request<{ data: ArgumentDefaults }>("/api/llama-args/defaults", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
