import type { ConfigReloadResult } from "@arriero/core";

import { config } from "../config.js";
import { normalizeConfigFiles } from "../config-normalize.js";
import { getActiveJob } from "../jobs/registry.js";
import { anySourceRepositoryOperationActive } from "../sources/state.js";
import { reloadPortableConfigCaches } from "./reload.js";
import { validateConfigRoot } from "./validation.js";

function assertConfigCanReload() {
  if (getActiveJob("build")) {
    throw new Error("cannot reload configuration while a build is running");
  }
  if (getActiveJob("envs")) {
    throw new Error(
      "cannot reload configuration while an environment install is running",
    );
  }
  if (anySourceRepositoryOperationActive()) {
    throw new Error(
      "cannot reload configuration while a source repository operation is running",
    );
  }
}

export function applyConfigFromDisk(): ConfigReloadResult {
  assertConfigCanReload();
  const validation = validateConfigRoot(config.configDir);
  if (!validation.valid) {
    return { applied: false, issues: validation.issues, normalizedFiles: [] };
  }
  reloadPortableConfigCaches();
  const normalizedFiles = normalizeConfigFiles();
  return { applied: true, issues: [], normalizedFiles };
}
