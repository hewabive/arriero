import type { ConfigReloadResult } from "@arriero/core";

import { config } from "../config.js";
import { normalizeConfigFiles } from "../config-normalize.js";
import { getConfigDoctorReportOrNull } from "../doctor/report.js";
import { assertNoBlockingBackgroundWork } from "./busy.js";
import { reloadPortableConfigCaches } from "./reload.js";
import { validateConfigRoot } from "./validation.js";

export async function applyConfigFromDisk(): Promise<ConfigReloadResult> {
  assertNoBlockingBackgroundWork("reload");
  const validation = validateConfigRoot(config.configDir);
  if (!validation.valid) {
    return {
      applied: false,
      issues: validation.issues,
      normalizedFiles: [],
      doctor: null,
    };
  }
  reloadPortableConfigCaches();
  const normalizedFiles = normalizeConfigFiles();
  const doctor = await getConfigDoctorReportOrNull();
  return { applied: true, issues: [], normalizedFiles, doctor };
}
