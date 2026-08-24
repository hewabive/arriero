import type { GgufMetadata, GgufModel, ModelScanSettings } from "@arriero/core";
import { eq, getTableColumns } from "drizzle-orm";
import { existsSync } from "node:fs";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { modelCache } from "../db/schema.js";
import { readSettings, writeSettings } from "../settings/store.js";
import { deriveCacheRowMetadata, parseCacheJson } from "./cache-row.js";
import {
  deriveGgufMetadata,
  GGUF_PARSER_VERSION,
  GGUF_RAW_VERSION,
  type GgufRawFacts,
} from "./gguf.js";

const defaultModelsDirectory = config.modelsDir;

const CACHE_LABEL = "model";

const { rawJson: omittedRawJson, ...modelCacheListColumns } =
  getTableColumns(modelCache);

type ModelCacheListRow = Omit<typeof modelCache.$inferSelect, "rawJson">;

export type CachedModelEntry = {
  sizeBytes: number;
  modifiedAt: string;
  model: GgufModel | null;
  facts: GgufRawFacts | null;
  derivedCurrent: boolean;
};

function modelFromRow(
  row: ModelCacheListRow,
  metadata: GgufMetadata,
): GgufModel | null {
  const mmprojPaths = parseCacheJson<string[]>(
    row.mmprojPathsJson,
    row.path,
    "mmproj_paths_json",
    CACHE_LABEL,
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

function cachedRawJson(path: string): string | null {
  const row = db
    .select({ rawJson: modelCache.rawJson })
    .from(modelCache)
    .where(eq(modelCache.path, path))
    .get();
  return row?.rawJson ?? null;
}

function entryFromRow(
  row: ModelCacheListRow,
  rawJson: () => string | null,
): CachedModelEntry {
  const derived = deriveCacheRowMetadata<GgufRawFacts, GgufMetadata>({
    row,
    rawJson,
    rawVersion: GGUF_RAW_VERSION,
    parserVersion: GGUF_PARSER_VERSION,
    label: CACHE_LABEL,
    derive: deriveGgufMetadata,
  });
  return {
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    model: derived.metadata ? modelFromRow(row, derived.metadata) : null,
    get facts() {
      return derived.facts();
    },
    derivedCurrent: derived.derivedCurrent,
  };
}

export function getCachedModelEntry(path: string): CachedModelEntry | null {
  const row = db
    .select(modelCacheListColumns)
    .from(modelCache)
    .where(eq(modelCache.path, path))
    .get();
  return row ? entryFromRow(row, () => cachedRawJson(path)) : null;
}

export function listAllCachedModels(): GgufModel[] {
  return db
    .select(modelCacheListColumns)
    .from(modelCache)
    .all()
    .map((row) => entryFromRow(row, () => cachedRawJson(row.path)).model)
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
  const rows = db.select({ path: modelCache.path }).from(modelCache).all();
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
