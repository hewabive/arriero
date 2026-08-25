import type { ConfigReloadResult } from "@arriero/core";

import { config } from "../config.js";
import { normalizeConfigFiles } from "../config-normalize.js";
import { getConfigDoctorReport } from "../doctor/report.js";
import { logger } from "../logger.js";
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
  let doctor = null;
  try {
    doctor = await getConfigDoctorReport();
  } catch (error) {
    logger.warn({ error }, "config doctor report failed");
  }
  return { applied: true, issues: [], normalizedFiles, doctor };
}
