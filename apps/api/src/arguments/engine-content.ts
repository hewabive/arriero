import type { EngineArgumentExtract } from "@arriero/core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { parseEngineArgumentExtract } from "./help-source.js";

export function engineArgumentContentPaths(engineId: string) {
  const root = resolve(config.rootDir, "content", "engine-args", engineId);
  return {
    docsDirectory: resolve(root, "args"),
    snapshotPath: resolve(root, "source", "extract.json"),
    metadataPath: resolve(root, "source", "help-source.json"),
  };
}

export type StoredEngineExtract = {
  path: string;
  exists: boolean;
  extract: EngineArgumentExtract | null;
  error: string | null;
  updatedAt: string | null;
};

const extractCache = new Map<
  string,
  { mtimeMs: number; value: StoredEngineExtract }
>();

export function readStoredEngineExtract(engineId: string): StoredEngineExtract {
  const { snapshotPath } = engineArgumentContentPaths(engineId);
  if (!existsSync(snapshotPath)) {
    return {
      path: snapshotPath,
      exists: false,
      extract: null,
      error: "stored argument extract not found",
      updatedAt: null,
    };
  }
  const stat = statSync(snapshotPath);
  const cached = extractCache.get(engineId);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.value;
  }
  const parsed = parseEngineArgumentExtract(readFileSync(snapshotPath, "utf8"));
  const value = {
    path: snapshotPath,
    exists: true,
    extract: parsed.extract,
    error: parsed.error,
    updatedAt: stat.mtime.toISOString(),
  };
  extractCache.set(engineId, { mtimeMs: stat.mtimeMs, value });
  return value;
}

export type EngineExtractMetadataFile = Partial<{
  schema: number;
  engine: string;
  entrypoint: string;
  sourcePaths: string[];
  hash: string;
  commit: string | null;
  updatedAt: string;
}>;

export function readEngineExtractMetadata(
  engineId: string,
): EngineExtractMetadataFile | null {
  const { metadataPath } = engineArgumentContentPaths(engineId);
  if (!existsSync(metadataPath)) {
    return null;
  }
  try {
    return JSON.parse(
      readFileSync(metadataPath, "utf8"),
    ) as EngineExtractMetadataFile;
  } catch {
    return null;
  }
}
