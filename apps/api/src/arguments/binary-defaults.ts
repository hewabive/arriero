import { GPU_LAYERS_ARG_KEYS } from "@arriero/core";
import { resolve } from "node:path";

import { binaryStat } from "./binary-discovery.js";
import {
  getCachedArgumentCatalog,
  type CachedArgumentCatalog,
} from "./repository.js";
import { readArgumentCatalogSidecar } from "./sidecar.js";

const HELP_DEFAULT_PATTERN = /\(default:\s*([^)]*)\)/g;
const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: string | null; expiresAt: number };

const gpuLayersDefaultCache = new Map<string, CacheEntry>();

function cachedCatalog(binaryPath: string): CachedArgumentCatalog | null {
  const fromDb = getCachedArgumentCatalog(binaryPath);
  if (fromDb) {
    return fromDb;
  }
  try {
    return readArgumentCatalogSidecar(binaryPath, binaryStat(binaryPath));
  } catch {
    return null;
  }
}

function helpDefault(help: string): string | null {
  const matches = [...help.matchAll(HELP_DEFAULT_PATTERN)];
  const value = matches[matches.length - 1]?.[1]?.trim() ?? "";
  return value === "" ? null : value;
}

function extractGpuLayersDefault(
  catalog: CachedArgumentCatalog,
): string | null {
  if (catalog.parserId !== "llama-help") {
    return null;
  }
  const option = catalog.options.find((candidate) =>
    candidate.names.some((name) => GPU_LAYERS_ARG_KEYS.includes(name)),
  );
  return option ? helpDefault(option.help) : null;
}

export function cachedGpuLayersDefault(binaryPathInput: string): string | null {
  const binaryPath = resolve(binaryPathInput);
  const now = Date.now();
  const cached = gpuLayersDefaultCache.get(binaryPath);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const catalog = cachedCatalog(binaryPath);
  const value = catalog ? extractGpuLayersDefault(catalog) : null;
  gpuLayersDefaultCache.set(binaryPath, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  });
  return value;
}
