import type { PrerequisiteReport } from "@llama-manager/core";

import { nodeRequest as request } from "./http.js";

export async function getPrerequisiteReport() {
  return request<{ data: PrerequisiteReport }>("/api/prerequisites");
}
