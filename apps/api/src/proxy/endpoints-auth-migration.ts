import { resolve } from "node:path";

import { config } from "../config.js";
import { readRawArray, writeRawJson } from "../migrations/raw-json.js";
import { ENDPOINTS_FILE } from "./endpoints.js";

function endpointsPath(): string {
  return resolve(config.proxyConfigDir, ENDPOINTS_FILE);
}

export function storedEndpointsHaveLegacyAuth(): boolean {
  const records = readRawArray(endpointsPath());
  return Boolean(records?.some((record) => "authType" in record));
}

function migrateRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (!("authType" in record)) {
    return record;
  }
  const authType = String(record["authType"] ?? "none");
  const usesEnv =
    authType === "env-bearer" || authType === "env-api-key-header";
  const usesHeader =
    authType === "api-key-header" || authType === "env-api-key-header";
  const { authType: _drop, authEnvVar, ...rest } = record;
  return {
    ...rest,
    apiKeyEnvVar: usesEnv ? ((authEnvVar as string | null) ?? null) : null,
    authHeaderName: usesHeader
      ? ((record["authHeaderName"] as string | null) ?? "x-api-key")
      : null,
    extraHeaders: record["extraHeaders"] ?? {},
    passthrough: record["passthrough"] ?? false,
    modelFilter: record["modelFilter"] ?? null,
  };
}

export function migrateStoredEndpointsAuth(): void {
  const records = readRawArray(endpointsPath());
  if (!records) {
    return;
  }
  writeRawJson(endpointsPath(), records.map(migrateRecord));
}
