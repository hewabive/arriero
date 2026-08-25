import {
  LogRetentionSettingsSchema,
  type LogRetentionSettings,
} from "@arriero/core";

import { readSettings, updateSettingsSection } from "./store.js";

const DEFAULT_LOG_RETENTION_SETTINGS = LogRetentionSettingsSchema.parse({});

export function getLogRetentionSettings(): LogRetentionSettings {
  return readSettings().logs ?? DEFAULT_LOG_RETENTION_SETTINGS;
}

export function saveLogRetentionSettings(
  input: LogRetentionSettings,
): LogRetentionSettings {
  const parsed = LogRetentionSettingsSchema.parse(input);
  updateSettingsSection("logs", parsed);
  return parsed;
}
