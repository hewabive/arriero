import { DRAFT_GPU_LAYERS_ARG_KEYS, GPU_LAYERS_ARG_KEYS } from "@arriero/core";
import { resolve } from "node:path";

import { binaryStat } from "./binary-discovery.js";
import {
  getCachedArgumentCatalog,
  type CachedArgumentCatalog,
} from "./repository.js";
import { readArgumentCatalogSidecar } from "./sidecar.js";

const HELP_DEFAULT_PATTERN = /\(default:\s*([^)]*)\)/g;
const CACHE_TTL_MS = 30_000;

export type GpuLayersDefaults = {
  main: string | null;
  draft: string | null;
};

const UNKNOWN_DEFAULTS: GpuLayersDefaults = { main: null, draft: null };

type CacheEntry = { value: GpuLayersDefaults; expiresAt: number };

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

function optionDefault(
  catalog: CachedArgumentCatalog,
  keys: string[],
): string | null {
  const option = catalog.options.find((candidate) =>
    candidate.names.some((name) => keys.includes(name)),
  );
  return option ? helpDefault(option.help) : null;
}

function extractGpuLayersDefaults(
  catalog: CachedArgumentCatalog,
): GpuLayersDefaults {
  if (catalog.parserId !== "llama-help") {
    return UNKNOWN_DEFAULTS;
  }
  return {
    main: optionDefault(catalog, GPU_LAYERS_ARG_KEYS),
    draft: optionDefault(catalog, DRAFT_GPU_LAYERS_ARG_KEYS),
  };
}

export function cachedGpuLayersDefaults(
  binaryPathInput: string,
): GpuLayersDefaults {
  if (binaryPathInput === "") {
    return UNKNOWN_DEFAULTS;
  }
  const binaryPath = resolve(binaryPathInput);
  const now = Date.now();
  const cached = gpuLayersDefaultCache.get(binaryPath);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const catalog = cachedCatalog(binaryPath);
  const value = catalog ? extractGpuLayersDefaults(catalog) : UNKNOWN_DEFAULTS;
  gpuLayersDefaultCache.set(binaryPath, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  });
  return value;
}
