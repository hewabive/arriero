import type { SafetensorsMetadata, SafetensorsModel } from "@arriero/core";
import { eq, getTableColumns } from "drizzle-orm";
import { existsSync } from "node:fs";

import { db } from "../db/index.js";
import { safetensorsCache } from "../db/schema.js";
import { logger } from "../logger.js";
import { deriveCacheRowMetadata, parseCacheJson } from "./cache-row.js";
import {
  deriveSafetensorsMetadata,
  listSafetensorsWeightNames,
  SAFETENSORS_PARSER_VERSION,
  SAFETENSORS_RAW_VERSION,
  type SafetensorsRawFacts,
} from "./safetensors.js";

const CACHE_LABEL = "safetensors";

const { rawJson: omittedRawJson, ...safetensorsCacheListColumns } =
  getTableColumns(safetensorsCache);

type SafetensorsCacheListRow = Omit<
  typeof safetensorsCache.$inferSelect,
  "rawJson"
>;

export type CachedSafetensorsEntry = {
  sizeBytes: number;
  modifiedAt: string;
  model: SafetensorsModel | null;
  facts: SafetensorsRawFacts | null;
  error: string | null;
  derivedCurrent: boolean;
};

function modelFromRow(
  row: SafetensorsCacheListRow,
  metadata: SafetensorsMetadata,
): SafetensorsModel | null {
  const weightFiles = parseCacheJson<string[]>(
    row.weightFilesJson,
    row.path,
    "weight_files_json",
    CACHE_LABEL,
  );
  const missingShardNames = parseCacheJson<string[]>(
    row.missingShardsJson,
    row.path,
    "missing_shards_json",
    CACHE_LABEL,
  );
  if (!weightFiles || !missingShardNames) {
    return null;
  }
  return {
    name: row.name,
    path: row.path,
    directory: row.directory,
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    weightFiles,
    missingShardNames,
    metadata,
    ...(row.error ? { error: row.error } : {}),
  };
}

function cachedRawJson(path: string): string | null {
  const row = db
    .select({ rawJson: safetensorsCache.rawJson })
    .from(safetensorsCache)
    .where(eq(safetensorsCache.path, path))
    .get();
  return row?.rawJson ?? null;
}

function entryFromRow(
  row: SafetensorsCacheListRow,
  rawJson: () => string | null,
): CachedSafetensorsEntry {
  const derived = deriveCacheRowMetadata<
    SafetensorsRawFacts,
    SafetensorsMetadata
  >({
    row,
    rawJson,
    rawVersion: SAFETENSORS_RAW_VERSION,
    parserVersion: SAFETENSORS_PARSER_VERSION,
    label: CACHE_LABEL,
    derive: deriveSafetensorsMetadata,
  });
  return {
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    model: derived.metadata ? modelFromRow(row, derived.metadata) : null,
    get facts() {
      return derived.facts();
    },
    error: row.error,
    derivedCurrent: derived.derivedCurrent,
  };
}

export function getCachedSafetensorsEntry(
  path: string,
): CachedSafetensorsEntry | null {
  const row = db
    .select()
    .from(safetensorsCache)
    .where(eq(safetensorsCache.path, path))
    .get();
  return row ? entryFromRow(row, () => row.rawJson) : null;
}

export function listAllCachedSafetensorsModels(): SafetensorsModel[] {
  return db
    .select(safetensorsCacheListColumns)
    .from(safetensorsCache)
    .all()
    .map((row) => entryFromRow(row, () => cachedRawJson(row.path)).model)
    .filter((model): model is SafetensorsModel => model !== null);
}

export function saveCachedSafetensorsModel(
  model: SafetensorsModel,
  facts: SafetensorsRawFacts | null,
) {
  const values = {
    name: model.name,
    directory: model.directory,
    sizeBytes: String(model.sizeBytes),
    modifiedAt: model.modifiedAt,
    weightFilesJson: JSON.stringify(model.weightFiles),
    missingShardsJson: JSON.stringify(model.missingShardNames),
    metadataJson: JSON.stringify(model.metadata),
    parserVersion: SAFETENSORS_PARSER_VERSION,
    rawJson: facts ? JSON.stringify(facts) : null,
    rawVersion: facts ? SAFETENSORS_RAW_VERSION : 0,
    error: model.error ?? null,
    scannedAt: new Date().toISOString(),
  };
  db.insert(safetensorsCache)
    .values({ path: model.path, ...values })
    .onConflictDoUpdate({ target: safetensorsCache.path, set: values })
    .run();
}

function directoryStillHoldsWeights(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return listSafetensorsWeightNames(path).length > 0;
  } catch (error) {
    logger.warn(
      { err: error, path },
      "safetensors cache directory could not be listed; keeping cache row",
    );
    return true;
  }
}

export function pruneMissingCachedSafetensorsModels(
  survivingPaths?: ReadonlySet<string>,
): number {
  const rows = db
    .select({ path: safetensorsCache.path })
    .from(safetensorsCache)
    .all();
  let deleted = 0;

  for (const row of rows) {
    if (survivingPaths?.has(row.path) || directoryStillHoldsWeights(row.path)) {
      continue;
    }

    const result = db
      .delete(safetensorsCache)
      .where(eq(safetensorsCache.path, row.path))
      .run();
    deleted += result.changes;
  }

  return deleted;
}
