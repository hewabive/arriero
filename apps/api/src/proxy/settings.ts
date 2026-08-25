import {
  ApiProxySettingsSchema,
  ApiProxySettingsUpdateSchema,
  type ApiProxySettings,
  type ApiProxySettingsUpdate,
} from "@arriero/core";
import { z } from "zod";

import { readObjectFile, writeObjectFile } from "./config-files.js";

const SETTINGS_FILE = "settings.json";

const StoredApiProxySettingsSchema: z.ZodType<ApiProxySettings> =
  ApiProxySettingsSchema.catchall(z.unknown());

export function getApiProxySettings(): ApiProxySettings {
  return readObjectFile(SETTINGS_FILE, StoredApiProxySettingsSchema);
}

export function updateApiProxySettings(
  input: ApiProxySettingsUpdate,
): ApiProxySettings {
  const parsed = ApiProxySettingsUpdateSchema.parse(input);
  const current = getApiProxySettings();
  const next: ApiProxySettings = {
    ...current,
    allowAnonymous: parsed.allowAnonymous ?? current.allowAnonymous,
    anonymousBlockedMessage:
      parsed.anonymousBlockedMessage ?? current.anonymousBlockedMessage,
    unknownKeyBlockedMessage:
      parsed.unknownKeyBlockedMessage ?? current.unknownKeyBlockedMessage,
    streamIdleTimeoutMs:
      parsed.streamIdleTimeoutMs !== undefined
        ? parsed.streamIdleTimeoutMs
        : current.streamIdleTimeoutMs,
  };
  writeObjectFile(SETTINGS_FILE, StoredApiProxySettingsSchema, next);
  return next;
}
