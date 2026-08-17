import type { GgufTensorTable, MemoryEstimateHparams } from "@arriero/core";

import { getCachedModelEntry } from "./cache-repository.js";
import {
  readGgufFactsOffThread,
  readGgufModelTensorTableOffThread,
} from "./gguf-worker-client.js";
import type { ModelFileIdentity } from "./file-identity.js";
import {
  deriveGgufMetadata,
  ggufFileIdentity,
  memoryEstimateHparams,
} from "./gguf.js";

const TENSOR_TABLE_CACHE_LIMIT = 8;

const tensorTables = new Map<string, GgufTensorTable>();

function identityKey(path: string, identity: ModelFileIdentity) {
  return `${path}|${identity.sizeBytes}|${identity.modifiedAt}`;
}

export async function loadGgufTensorTable(
  path: string,
): Promise<GgufTensorTable> {
  const key = identityKey(path, await ggufFileIdentity(path));
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
  const identity = await ggufFileIdentity(path);
  const entry = getCachedModelEntry(path);
  const fresh =
    entry !== null &&
    entry.sizeBytes === identity.sizeBytes &&
    entry.modifiedAt === identity.modifiedAt;
  if (fresh && entry.model && entry.derivedCurrent) {
    return memoryEstimateHparams(entry.model.metadata);
  }
  const facts =
    fresh && entry.facts ? entry.facts : await readGgufFactsOffThread(path);
  return memoryEstimateHparams(deriveGgufMetadata(facts));
}
