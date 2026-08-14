import {
  ApiProxySettingsSchema,
  ApiProxySettingsUpdateSchema,
  type ApiProxySettings,
  type ApiProxySettingsUpdate,
} from "@arriero/core";

import { readObjectFile, writeObjectFile } from "./config-files.js";

const SETTINGS_FILE = "settings.json";

export function getApiProxySettings(): ApiProxySettings {
  return readObjectFile(SETTINGS_FILE, ApiProxySettingsSchema);
}

export function updateApiProxySettings(
  input: ApiProxySettingsUpdate,
): ApiProxySettings {
  const parsed = ApiProxySettingsUpdateSchema.parse(input);
  const current = getApiProxySettings();
  const next: ApiProxySettings = {
    allowAnonymous: parsed.allowAnonymous ?? current.allowAnonymous,
  };
  writeObjectFile(SETTINGS_FILE, ApiProxySettingsSchema, next);
  return next;
}
