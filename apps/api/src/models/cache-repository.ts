import type { GgufModel, ModelScanSettings } from "@arriero/core";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { modelCache } from "../db/schema.js";
import { readSettings, writeSettings } from "../settings/store.js";
import { GGUF_PARSER_VERSION } from "./gguf.js";

const defaultModelsDirectory = config.modelsDir;

type ModelCacheRow = typeof modelCache.$inferSelect;

function toModel(row: ModelCacheRow): GgufModel {
  return {
    name: row.name,
    path: row.path,
    directory: row.directory,
    sizeBytes: Number(row.sizeBytes),
    modifiedAt: row.modifiedAt,
    isMmproj: row.isMmproj === "true",
    mmprojPaths: JSON.parse(row.mmprojPathsJson) as string[],
    metadata: JSON.parse(row.metadataJson) as GgufModel["metadata"],
    ...(row.error ? { error: row.error } : {}),
  };
}

export function getCachedModel(path: string): GgufModel | null {
  const row = db
    .select()
    .from(modelCache)
    .where(eq(modelCache.path, path))
    .get();
  if (!row || row.parserVersion !== GGUF_PARSER_VERSION) {
    return null;
  }
  return toModel(row);
}

export function listAllCachedModels(): GgufModel[] {
  return db
    .select()
    .from(modelCache)
    .all()
    .filter((row) => row.parserVersion === GGUF_PARSER_VERSION)
    .map(toModel);
}

export function saveCachedModel(model: GgufModel) {
  db.insert(modelCache)
    .values({
      path: model.path,
      name: model.name,
      directory: model.directory,
      sizeBytes: String(model.sizeBytes),
      modifiedAt: model.modifiedAt,
      isMmproj: String(model.isMmproj),
      mmprojPathsJson: JSON.stringify(model.mmprojPaths),
      metadataJson: JSON.stringify(model.metadata),
      parserVersion: GGUF_PARSER_VERSION,
      error: model.error ?? null,
      scannedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: modelCache.path,
      set: {
        name: model.name,
        directory: model.directory,
        sizeBytes: String(model.sizeBytes),
        modifiedAt: model.modifiedAt,
        isMmproj: String(model.isMmproj),
        mmprojPathsJson: JSON.stringify(model.mmprojPaths),
        metadataJson: JSON.stringify(model.metadata),
        parserVersion: GGUF_PARSER_VERSION,
        error: model.error ?? null,
        scannedAt: new Date().toISOString(),
      },
    })
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
