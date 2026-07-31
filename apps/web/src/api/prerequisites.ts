import type {
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
  PrerequisiteReport,
} from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function getPrerequisiteReport() {
  return request<{ data: PrerequisiteReport }>("/api/prerequisites");
}

export async function getPrerequisiteInstallRun() {
  return request<{ data: PrerequisiteInstallRun | null }>(
    "/api/prerequisites/install/latest",
  );
}

export async function startPrerequisiteInstall(
  start: PrerequisiteInstallStart,
) {
  return request<{ data: PrerequisiteInstallRun }>(
    "/api/prerequisites/install",
    { method: "POST", body: JSON.stringify(start) },
  );
}
