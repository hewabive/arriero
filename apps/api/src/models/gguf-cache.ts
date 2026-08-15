import type { GgufTensorTable, MemoryEstimateHparams } from "@arriero/core";
import { stat } from "node:fs/promises";

import { getCachedModelEntry } from "./cache-repository.js";
import {
  readGgufFactsOffThread,
  readGgufModelTensorTableOffThread,
} from "./gguf-worker-client.js";
import {
  deriveGgufMetadata,
  memoryEstimateHparams,
  resolveGgufShardPaths,
} from "./gguf.js";

const TENSOR_TABLE_CACHE_LIMIT = 8;

const tensorTables = new Map<string, GgufTensorTable>();

async function fileIdentity(path: string) {
  const stats = await Promise.all(
    resolveGgufShardPaths(path).map((shard) => stat(shard)),
  );
  const sizeBytes = stats.reduce((sum, item) => sum + item.size, 0);
  const modifiedAt = new Date(
    Math.max(...stats.map((item) => item.mtime.getTime())),
  ).toISOString();
  return { key: `${path}|${sizeBytes}|${modifiedAt}`, sizeBytes, modifiedAt };
}

export async function loadGgufTensorTable(
  path: string,
): Promise<GgufTensorTable> {
  const { key } = await fileIdentity(path);
  const cached = tensorTables.get(key);
  if (cached) {
    tensorTables.delete(key);
    tensorTables.set(key, cached);
    return cached;
  }

  const table = await readGgufModelTensorTableOffThread(path);
  tensorTables.set(key, table);
  while (tensorTables.size > TENSOR_TABLE_CACHE_LIMIT) {
    const oldest = tensorTables.keys().next();
    if (oldest.done) {
      break;
    }
    tensorTables.delete(oldest.value);
  }
  return table;
}

export async function loadGgufHparams(
  path: string,
): Promise<MemoryEstimateHparams> {
  const identity = await fileIdentity(path);
  const entry = getCachedModelEntry(path);
  const facts =
    entry?.facts &&
    entry.sizeBytes === identity.sizeBytes &&
    entry.modifiedAt === identity.modifiedAt
      ? entry.facts
      : await readGgufFactsOffThread(path);
  return memoryEstimateHparams(deriveGgufMetadata(facts));
}
