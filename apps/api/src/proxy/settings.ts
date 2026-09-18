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

export function updateApiProxySettings(
  input: ApiProxySettingsUpdate,
): ApiProxySettings {
  const parsed = ApiProxySettingsUpdateSchema.parse(input);
  const current = getApiProxySettings();
  if (
    parsed.agentSessionEndpointId &&
    !getExternalApiEndpoint(parsed.agentSessionEndpointId)
  ) {
    throw new Error(
      "Agent session API requires an existing external endpoint.",
    );
  }
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
    traceRetentionDays: parsed.traceRetentionDays ?? current.traceRetentionDays,
    agentSessionEndpointId:
      parsed.agentSessionEndpointId !== undefined
        ? parsed.agentSessionEndpointId
        : current.agentSessionEndpointId,
  };
  writeObjectFile(SETTINGS_FILE, StoredApiProxySettingsSchema, next);
  return next;
}
