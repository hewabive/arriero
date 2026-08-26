import { ApiProxyModelRecordSchema } from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { readRawArray } from "../migrations/raw-json.js";
import { writeCollection } from "./config-files.js";
import { MODELS_FILE, StoredApiProxyModelSchema } from "./repository.js";

function readRawModels(): Record<string, unknown>[] | null {
  const path = resolve(config.proxyConfigDir, MODELS_FILE);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = readRawArray(path);
  if (parsed === null) {
    throw new Error(`Invalid config in ${path}: expected an array`);
  }
  return parsed;
}

function isLegacyModelRecord(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("visible" in (value as Record<string, unknown>))
  );
}

export function hasLegacyModelVisibility(): boolean {
  const raw = readRawModels();
  return raw !== null && raw.some(isLegacyModelRecord);
}

export function migrateModelVisibility(): void {
  const raw = readRawModels();
  if (!raw) {
    return;
  }
  const upgraded = raw.map((record) =>
    ApiProxyModelRecordSchema.parse(
      isLegacyModelRecord(record)
        ? { ...record, visible: record.enabled === true, enabled: true }
        : record,
    ),
  );
  writeCollection(MODELS_FILE, StoredApiProxyModelSchema, upgraded);
}
