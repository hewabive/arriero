import type {
  ArgumentCatalog,
  EngineHelpSourceSync,
  LlamaArgumentEngineeringDoc,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export type EngineArgumentReferenceSummary = {
  engineId: string;
  displayName: string;
  entrypoint: string | null;
  commit: string | null;
  updatedAt: string | null;
  total: number | null;
  documented: number;
};

export async function listEngineArgumentReferences() {
  return request<{ data: EngineArgumentReferenceSummary[] }>(
    "/api/engine-args/references",
  );
}

export async function getEngineArgumentReference(engineId: string) {
  return request<{ data: ArgumentCatalog }>(
    `/api/engine-args/${encodeURIComponent(engineId)}/reference`,
  );
}

export async function getEngineArgumentDoc(
  engineId: string,
  primaryName: string,
) {
  return request<{ data: LlamaArgumentEngineeringDoc }>(
    `/api/engine-args/${encodeURIComponent(engineId)}/docs/${encodeURIComponent(primaryName)}`,
  );
}

export async function listEngineHelpSources() {
  return request<{ data: EngineHelpSourceSync[] }>(
    "/api/engine-args/help-sources",
  );
}

export async function getEngineHelpSourceDiff(engineId: string) {
  return request<{ data: { diff: string } }>(
    `/api/engine-args/help-sources/${encodeURIComponent(engineId)}/diff`,
  );
}
