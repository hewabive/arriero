import type { ConfigReloadResult } from "@arriero/core";

import { config } from "../config.js";
import { normalizeConfigFiles } from "../config-normalize.js";
import { assertNoBlockingBackgroundWork } from "./busy.js";
import { reloadPortableConfigCaches } from "./reload.js";
import { validateConfigRoot } from "./validation.js";

export function applyConfigFromDisk(): ConfigReloadResult {
  assertNoBlockingBackgroundWork("reload");
  const validation = validateConfigRoot(config.configDir);
  if (!validation.valid) {
    return { applied: false, issues: validation.issues, normalizedFiles: [] };
  }
  reloadPortableConfigCaches();
  const normalizedFiles = normalizeConfigFiles();
  return { applied: true, issues: [], normalizedFiles };
}
