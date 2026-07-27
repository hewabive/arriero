import type { PrerequisiteReport } from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function getPrerequisiteReport() {
  return request<{ data: PrerequisiteReport }>("/api/prerequisites");
}
