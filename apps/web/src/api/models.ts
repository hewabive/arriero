import type { ModelScanSettings, ModelScanResult } from "@arriero/core";

import { buildQuery, nodeRequest as request } from "./http.js";

export async function scanModels(input?: {
  refresh?: boolean;
  cached?: boolean;
}) {
  const query = buildQuery({
    refresh: input?.refresh ? "true" : undefined,
    cached: input?.cached ? "true" : undefined,
  });
  return request<{ data: ModelScanResult }>(`/api/models${query}`);
}

export async function getModelScanSettings() {
  return request<{ data: ModelScanSettings }>("/api/model-scan-settings");
}

export async function updateModelScanSettings(input: ModelScanSettings) {
  return request<{ data: ModelScanSettings }>("/api/model-scan-settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
