import type { EngineHelpSourceSync } from "@arriero/core";

import { nodeRequest as request } from "./http.js";

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
