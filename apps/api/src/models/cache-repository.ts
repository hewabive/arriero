import type { GgufMetadata, GgufModel, ModelScanSettings } from "@arriero/core";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { modelCache } from "../db/schema.js";
import { logger } from "../logger.js";
import { readSettings, writeSettings } from "../settings/store.js";
import {
  deriveGgufMetadata,
  GGUF_PARSER_VERSION,
  GGUF_RAW_VERSION,
  type GgufRawFacts,
} from "./gguf.js";

const defaultModelsDirectory = config.modelsDir;

type ModelCacheRow = typeof modelCache.$inferSelect;

export type CachedModelEntry = {
  sizeBytes: number;
  modifiedAt: string;
  model: GgufModel | null;
  facts: GgufRawFacts | null;
  derivedCurrent: boolean;
};

function parseJson<T>(value: string, path: string, field: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn(
      { err: error, path, field },
      "model cache row could not be parsed",
    );
    return null;
  }
}

function factsFromRow(row: ModelCacheRow): GgufRawFacts | null {
  if (row.rawVersion !== GGUF_RAW_VERSION || !row.rawJson) {
    return null;
  }
  return parseJson<GgufRawFacts>(row.rawJson, row.path, "raw_json");
}

function metadataFromRow(
  row: ModelCacheRow,
  facts: () => GgufRawFacts | null,
): { metadata: GgufMetadata | null; derivedCurrent: boolean } {
  if (row.parserVersion === GGUF_PARSER_VERSION) {
    const stored = parseJson<GgufMetadata>(
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
    metadata: loaded ? deriveGgufMetadata(loaded) : null,
    derivedCurrent: false,
  };
}

function modelFromRow(
  row: ModelCacheRow,
  metadata: GgufMetadata,
): GgufModel | null {
  const mmprojPaths = parseJson<string[]>(
    row.mmprojPathsJson,
    row.path,
    "mmproj_paths_json",
  );
  if (!mmprojPaths) {
    return null;
  }
  return {
    name: row.name,
    path: row.path,
    directory: row.directory,
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    isMmproj: row.isMmproj === "true",
    mmprojPaths,
    metadata,
    ...(row.error ? { error: row.error } : {}),
  };
}

function entryFromRow(row: ModelCacheRow): CachedModelEntry {
  let factsMemo: GgufRawFacts | null | undefined;
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
    derivedCurrent,
  };
}

export function getCachedModelEntry(path: string): CachedModelEntry | null {
  const row = db
    .select()
    .from(modelCache)
    .where(eq(modelCache.path, path))
    .get();
  return row ? entryFromRow(row) : null;
}

export function listAllCachedModels(): GgufModel[] {
  return db
    .select()
    .from(modelCache)
    .all()
    .map((row) => entryFromRow(row).model)
    .filter((model): model is GgufModel => model !== null);
}

export function saveCachedModel(model: GgufModel, facts: GgufRawFacts | null) {
  const values = {
    name: model.name,
    directory: model.directory,
    sizeBytes: String(model.sizeBytes),
    modifiedAt: model.modifiedAt,
    isMmproj: String(model.isMmproj),
    mmprojPathsJson: JSON.stringify(model.mmprojPaths),
    metadataJson: JSON.stringify(model.metadata),
    parserVersion: GGUF_PARSER_VERSION,
    rawJson: facts ? JSON.stringify(facts) : null,
    rawVersion: facts ? GGUF_RAW_VERSION : 0,
    error: model.error ?? null,
    scannedAt: new Date().toISOString(),
  };
  db.insert(modelCache)
    .values({ path: model.path, ...values })
    .onConflictDoUpdate({ target: modelCache.path, set: values })
    .run();
}

export function pruneMissingCachedModels(): number {
  const rows = db.select().from(modelCache).all();
  let deleted = 0;

  for (const row of rows) {
    if (existsSync(row.path)) {
      continue;
    }

    const result = db
      .delete(modelCache)
      .where(eq(modelCache.path, row.path))
      .run();
    deleted += result.changes;
  }

  return deleted;
}

export function getModelScanSettings(): ModelScanSettings {
  return (
    readSettings().modelScan ?? {
      directory: defaultModelsDirectory,
      maxDepth: 8,
    }
  );
}

export function saveModelScanSettings(
  input: ModelScanSettings,
): ModelScanSettings {
  writeSettings({ ...readSettings(), modelScan: input });
  return input;
}
