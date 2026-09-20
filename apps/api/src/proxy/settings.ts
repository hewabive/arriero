import {
  ApiProxySettingsSchema,
  ApiProxySettingsUpdateSchema,
  type ApiProxySettings,
  type ApiProxySettingsUpdate,
} from "@arriero/core";
import { z } from "zod";

import { readObjectFile, writeObjectFile } from "./config-files.js";
import { getExternalApiEndpoint } from "./endpoints.js";

const SETTINGS_FILE = "settings.json";

const StoredApiProxySettingsSchema: z.ZodType<ApiProxySettings> =
  ApiProxySettingsSchema.catchall(z.unknown());

export function getApiProxySettings(): ApiProxySettings {
  return readObjectFile(SETTINGS_FILE, StoredApiProxySettingsSchema);
}

export function validateApiProxySettingsRefs(
  input: ApiProxySettingsUpdate,
): string | null {
  if (!input.filesEndpointId) {
    return null;
  }
  const endpoint = getExternalApiEndpoint(input.filesEndpointId);
  return endpoint?.enabled && endpoint.profile === "openai"
    ? null
    : "Default Files API endpoint must be an enabled external OpenAI endpoint";
}

export function updateApiProxySettings(
  input: ApiProxySettingsUpdate,
): ApiProxySettings {
  const parsed = ApiProxySettingsUpdateSchema.parse(input);
  const current = getApiProxySettings();
  const next: ApiProxySettings = {
    ...current,
    filesEndpointId:
      parsed.filesEndpointId !== undefined
        ? parsed.filesEndpointId
        : current.filesEndpointId,
    allowAnonymous: parsed.allowAnonymous ?? current.allowAnonymous,
    anonymousBlockedMessage:
      parsed.anonymousBlockedMessage ?? current.anonymousBlockedMessage,
    unknownKeyBlockedMessage:
      parsed.unknownKeyBlockedMessage ?? current.unknownKeyBlockedMessage,
    streamIdleTimeoutMs:
      parsed.streamIdleTimeoutMs !== undefined
        ? parsed.streamIdleTimeoutMs
        : current.streamIdleTimeoutMs,
    traceRetentionDays: parsed.traceRetentionDays ?? current.traceRetentionDays,
  };
  writeObjectFile(SETTINGS_FILE, StoredApiProxySettingsSchema, next);
  return next;
}
