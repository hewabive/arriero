import {
  ApiProxyPipelineRecordSchema,
  upgradeLegacyApiProxyPipeline,
} from "@arriero/core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { writeCollection } from "./config-files.js";
import { PIPELINES_FILE, StoredApiProxyPipelineSchema } from "./repository.js";

function readRawPipelines(): unknown[] | null {
  const path = resolve(config.proxyConfigDir, PIPELINES_FILE);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${path}: expected an array`);
  }
  return parsed;
}

function isLegacyPipelineRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("nodes" in record || "entry" in record) {
    return false;
  }
  return "steps" in record || "routeTo" in record || "nodeType" in record;
}

export function hasLegacyPipelineRecords(): boolean {
  const raw = readRawPipelines();
  return raw !== null && raw.some(isLegacyPipelineRecord);
}

export function migratePipelinesToGraphFormat(): void {
  const raw = readRawPipelines();
  if (!raw) {
    return;
  }
  const upgraded = raw.map((record) =>
    ApiProxyPipelineRecordSchema.parse(upgradeLegacyApiProxyPipeline(record)),
  );
  writeCollection(PIPELINES_FILE, StoredApiProxyPipelineSchema, upgraded);
}
