import type {
  ModelScanRequest,
  ModelScanResult,
  ModelScanSettings,
  ModelScanState,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function scanModels() {
  return request<{ data: ModelScanResult }>("/api/models");
}

export async function startModelScan(input?: ModelScanRequest) {
  return request<{ data: ModelScanState }>("/api/models/scan", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
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
