import {
  ApiProxySettingsSchema,
  ApiProxySettingsUpdateSchema,
  type ApiProxySettings,
  type ApiProxySettingsUpdate,
} from "@arriero/core";

import { readObjectFile, writeObjectFile } from "./config-files.js";

export const PROXY_SETTINGS_FILE = "settings.json";

export function getApiProxySettings(): ApiProxySettings {
  return readObjectFile(PROXY_SETTINGS_FILE, ApiProxySettingsSchema);
}

export function updateApiProxySettings(
  input: ApiProxySettingsUpdate,
): ApiProxySettings {
  const parsed = ApiProxySettingsUpdateSchema.parse(input);
  const current = getApiProxySettings();
  const next = ApiProxySettingsSchema.parse({
    allowAnonymous: parsed.allowAnonymous ?? current.allowAnonymous,
  });
  writeObjectFile(PROXY_SETTINGS_FILE, next);
  return next;
}
