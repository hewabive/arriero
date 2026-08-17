import type { SafetensorsMetadata, SafetensorsModel } from "@arriero/core";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";

import { db } from "../db/index.js";
import { safetensorsCache } from "../db/schema.js";
import { logger } from "../logger.js";
import {
  deriveSafetensorsMetadata,
  listSafetensorsWeightNames,
  SAFETENSORS_PARSER_VERSION,
  SAFETENSORS_RAW_VERSION,
  type SafetensorsRawFacts,
} from "./safetensors.js";

type SafetensorsCacheRow = typeof safetensorsCache.$inferSelect;

export type CachedSafetensorsEntry = {
  sizeBytes: number;
  modifiedAt: string;
  model: SafetensorsModel | null;
  facts: SafetensorsRawFacts | null;
  error: string | null;
  derivedCurrent: boolean;
};

function parseJson<T>(value: string, path: string, field: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn(
      { err: error, path, field },
      "safetensors cache row could not be parsed",
    );
    return null;
  }
}

function factsFromRow(row: SafetensorsCacheRow): SafetensorsRawFacts | null {
  if (row.rawVersion !== SAFETENSORS_RAW_VERSION || !row.rawJson) {
    return null;
  }
  return parseJson<SafetensorsRawFacts>(row.rawJson, row.path, "raw_json");
}

function metadataFromRow(
  row: SafetensorsCacheRow,
  facts: () => SafetensorsRawFacts | null,
): { metadata: SafetensorsMetadata | null; derivedCurrent: boolean } {
  if (row.parserVersion === SAFETENSORS_PARSER_VERSION) {
    const stored = parseJson<SafetensorsMetadata>(
      row.metadataJson,
      row.path,
      "metadata_json",
    );
    if (stored) {
      return { metadata: stored, derivedCurrent: true };
    }
  }
  const loaded = facts();
  return {
    metadata: loaded ? deriveSafetensorsMetadata(loaded) : null,
    derivedCurrent: false,
  };
}

function modelFromRow(
  row: SafetensorsCacheRow,
  metadata: SafetensorsMetadata,
): SafetensorsModel | null {
  const weightFiles = parseJson<string[]>(
    row.weightFilesJson,
    row.path,
    "weight_files_json",
  );
  const missingShardNames = parseJson<string[]>(
    row.missingShardsJson,
    row.path,
    "missing_shards_json",
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

function entryFromRow(row: SafetensorsCacheRow): CachedSafetensorsEntry {
  let factsMemo: SafetensorsRawFacts | null | undefined;
  const facts = () => {
    if (factsMemo === undefined) {
      factsMemo = factsFromRow(row);
    }
    return factsMemo;
  };
  const { metadata, derivedCurrent } = metadataFromRow(row, facts);
  return {
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    model: metadata ? modelFromRow(row, metadata) : null,
    get facts() {
      return facts();
    },
    error: row.error,
    derivedCurrent,
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
  return row ? entryFromRow(row) : null;
}

export function listAllCachedSafetensorsModels(): SafetensorsModel[] {
  return db
    .select()
    .from(safetensorsCache)
    .all()
    .map((row) => entryFromRow(row).model)
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

export function pruneMissingCachedSafetensorsModels(): number {
  const rows = db.select().from(safetensorsCache).all();
  let deleted = 0;

  for (const row of rows) {
    if (directoryStillHoldsWeights(row.path)) {
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
