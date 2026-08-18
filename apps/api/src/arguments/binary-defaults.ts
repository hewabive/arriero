import { DRAFT_GPU_LAYERS_ARG_KEYS, GPU_LAYERS_ARG_KEYS } from "@arriero/core";
import { resolve } from "node:path";

import { binaryStat } from "./binary-discovery.js";
import { getCurrentCachedCatalog } from "./catalog.js";
import type { CachedArgumentCatalog } from "./repository.js";

const HELP_DEFAULT_PATTERN = /\(default:\s*([^)]*)\)/g;
const UNKNOWN_RETRY_MS = 30_000;

export type GpuLayersDefaults = {
  main: string | null;
  draft: string | null;
};

const UNKNOWN_DEFAULTS: GpuLayersDefaults = { main: null, draft: null };

type CacheEntry = {
  binarySize: number;
  binaryMtimeMs: string;
  retryAt: number | null;
  value: GpuLayersDefaults;
};

const gpuLayersDefaultCache = new Map<string, CacheEntry>();

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
  let stat: ReturnType<typeof binaryStat>;
  try {
    stat = binaryStat(binaryPath);
  } catch {
    gpuLayersDefaultCache.delete(binaryPath);
    return UNKNOWN_DEFAULTS;
  }
  const now = Date.now();
  const cached = gpuLayersDefaultCache.get(binaryPath);
  if (
    cached &&
    cached.binarySize === stat.binarySize &&
    cached.binaryMtimeMs === stat.binaryMtimeMs &&
    (cached.retryAt === null || cached.retryAt > now)
  ) {
    return cached.value;
  }
  const catalog = getCurrentCachedCatalog(binaryPath);
  const value = catalog ? extractGpuLayersDefaults(catalog) : UNKNOWN_DEFAULTS;
  gpuLayersDefaultCache.set(binaryPath, {
    binarySize: stat.binarySize,
    binaryMtimeMs: stat.binaryMtimeMs,
    retryAt: catalog ? null : now + UNKNOWN_RETRY_MS,
    value,
  });
  return value;
}
