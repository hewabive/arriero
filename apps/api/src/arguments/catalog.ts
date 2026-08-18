import type {
  EngineArgumentCatalogParserId,
  ArgumentCatalog,
  ArgumentOption,
} from "@arriero/core";
import { ArgumentCatalogSchema } from "@arriero/core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  getCachedArgumentCatalog,
  saveArgumentCatalog,
  type CachedArgumentCatalog,
} from "./repository.js";
import { argumentDocsDirectory, withArgumentDocIndex } from "./docs.js";
import {
  defaultArgumentControl,
  loadArgumentRegistry,
  registryNameMap,
} from "./registry.js";
import {
  binaryStat,
  defaultBinaryPath,
  runHelpAsync,
} from "./binary-discovery.js";
import {
  readArgumentCatalogSidecar,
  writeArgumentCatalogSidecar,
} from "./sidecar.js";
import { parseLlamaArgumentOptions } from "./help-parser.js";
import { parseVllmArgumentOptions } from "./vllm-help-parser.js";
import { parseSglangArgumentOptions } from "./sglang-help-parser.js";
import {
  vllmFallbackArgumentOptions,
  vllmFallbackHelpHash,
} from "./vllm-fallback.js";
import {
  sglangFallbackArgumentOptions,
  sglangFallbackHelpHash,
} from "./sglang-fallback.js";
import {
  categoryNameRu,
  helpRuOverlay,
  optionFallbackHelpRu,
} from "./help-text-ru.js";

export { defaultBinaryPath } from "./binary-discovery.js";
export { parseLlamaArgumentOptions } from "./help-parser.js";

export type ArgumentCatalogHelpParserId = Exclude<
  EngineArgumentCatalogParserId,
  "none"
>;

const HELP_PARSERS: Record<
  ArgumentCatalogHelpParserId,
  (helpOutput: string) => ArgumentOption[]
> = {
  "llama-help": parseLlamaArgumentOptions,
  "vllm-help": parseVllmArgumentOptions,
  "sglang-help": parseSglangArgumentOptions,
};

const HELP_INVOCATIONS: Record<
  ArgumentCatalogHelpParserId,
  { args: string[]; timeoutMs: number }
> = {
  "llama-help": { args: ["--help"], timeoutMs: 10_000 },
  "vllm-help": { args: ["serve", "--help=all"], timeoutMs: 60_000 },
  "sglang-help": { args: ["serve", "--help"], timeoutMs: 60_000 },
};

function helpCommand(
  binaryPath: string,
  parserId: ArgumentCatalogHelpParserId,
) {
  const invocation = helpInvocation(binaryPath, parserId);
  return [invocation.binaryPath, ...invocation.args];
}

function sglangLanguageServerHelpInvocation(
  binaryPath: string,
  timeoutMs: number,
) {
  const venvPython = resolve(
    dirname(binaryPath),
    process.platform === "win32" ? "python.exe" : "python",
  );
  return existsSync(venvPython)
    ? {
        binaryPath: venvPython,
        args: ["-m", "sglang.launch_server", "--help"],
        timeoutMs,
      }
    : null;
}

function helpInvocation(
  binaryPath: string,
  parserId: ArgumentCatalogHelpParserId,
) {
  const configured = HELP_INVOCATIONS[parserId];
  const umbrellaCliInvocation = { binaryPath, ...configured };
  if (parserId !== "sglang-help") {
    return umbrellaCliInvocation;
  }
  return (
    sglangLanguageServerHelpInvocation(binaryPath, configured.timeoutMs) ??
    umbrellaCliInvocation
  );
}

function nowIso() {
  return new Date().toISOString();
}

function catalogMatchesBinary(
  cached: CachedArgumentCatalog,
  stat: ReturnType<typeof binaryStat>,
) {
  const primaryNames = cached.options.map((option) => option.primaryName);
  return (
    cached.binarySize === stat.binarySize &&
    cached.binaryMtimeMs === stat.binaryMtimeMs &&
    new Set(primaryNames).size === primaryNames.length
  );
}

function isCacheCurrent(
  cached: CachedArgumentCatalog,
  stat: ReturnType<typeof binaryStat>,
  parserId: ArgumentCatalogHelpParserId,
) {
  return catalogMatchesBinary(cached, stat) && cached.parserId === parserId;
}

export function getCurrentCachedCatalog(
  binaryPath: string,
): CachedArgumentCatalog | null {
  let stat: ReturnType<typeof binaryStat>;
  try {
    stat = binaryStat(binaryPath);
  } catch {
    return null;
  }
  const cached = getCachedArgumentCatalog(binaryPath);
  if (cached && catalogMatchesBinary(cached, stat)) {
    return cached;
  }
  const fromSidecar = readArgumentCatalogSidecar(binaryPath, stat);
  return fromSidecar && catalogMatchesBinary(fromSidecar, stat)
    ? fromSidecar
    : null;
}

function applyArgumentHelp(options: ArgumentOption[]) {
  return options.map((option) => {
    const category = categoryNameRu(option.category);
    if (option.helpRuSource === "registry") {
      return {
        ...option,
        category,
      };
    }

    const builtinHelp = helpRuOverlay[option.primaryName];
    if (builtinHelp) {
      return {
        ...option,
        category,
        helpRu: builtinHelp,
        helpRuSource: "builtin" as const,
      };
    }

    return {
      ...option,
      category,
      helpRu: optionFallbackHelpRu(option),
      helpRuSource: "fallback" as const,
    };
  });
}

function mergeWithArgumentRegistry(
  binaryOptions: ArgumentOption[],
  registry: ReturnType<typeof loadArgumentRegistry>,
): ArgumentOption[] {
  const registryByName = registryNameMap(registry);
  const matchedRegistrySlugs = new Set<string>();
  const merged: ArgumentOption[] = [];

  for (const binaryOption of binaryOptions) {
    const registryEntry =
      binaryOption.names
        .map(
          (name) =>
            registryByName.get(name) ??
            registryByName.get(name.replace(/^-+/, "")),
        )
        .find(Boolean) ??
      registryByName.get(binaryOption.primaryName) ??
      null;

    if (!registryEntry) {
      merged.push({
        ...binaryOption,
        control: defaultArgumentControl({
          primaryName: binaryOption.primaryName,
          valueType: binaryOption.valueType,
          allowedValues: binaryOption.allowedValues,
        }),
        compatibility: {
          metadataSource: "binary",
          presentInBinary: true,
          binaryPrimaryName: binaryOption.primaryName,
          binaryNames: binaryOption.names,
        },
      });
      continue;
    }

    matchedRegistrySlugs.add(registryEntry.slug);
    const registryOption = registryEntry.option;
    merged.push({
      ...binaryOption,
      primaryName: registryOption.primaryName,
      names: registryOption.names,
      category: registryOption.category,
      valueHint: registryOption.valueHint,
      valueType: registryOption.valueType,
      env: registryOption.env,
      allowedValues: registryOption.allowedValues,
      helpRu: registryOption.helpRu,
      helpRuSource: registryOption.helpRuSource,
      control: registryOption.control,
      compatibility: {
        metadataSource: "registry",
        presentInBinary: true,
        binaryPrimaryName: binaryOption.primaryName,
        binaryNames: binaryOption.names,
      },
      deprecated: binaryOption.deprecated || registryOption.deprecated,
    });
  }

  for (const registryEntry of registry) {
    if (matchedRegistrySlugs.has(registryEntry.slug)) {
      continue;
    }
    merged.push(registryEntry.option);
  }

  return merged.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.primaryName.localeCompare(right.primaryName),
  );
}

function withArgumentDocsAndCompatibility(options: ArgumentOption[]) {
  return withArgumentDocIndex(options);
}

function referenceCatalogHash(options: ArgumentOption[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        options.map((option) => ({
          primaryName: option.primaryName,
          names: option.names,
          category: option.category,
          valueHint: option.valueHint,
          valueType: option.valueType,
          env: option.env,
          allowedValues: option.allowedValues,
          help: option.help,
          helpRu: option.helpRu,
          control: option.control,
        })),
      ),
    )
    .digest("hex");
}

export function getLlamaArgumentReferenceCatalog(): ArgumentCatalog {
  const options = withArgumentDocsAndCompatibility(
    applyArgumentHelp(loadArgumentRegistry().map((entry) => entry.option)),
  );
  const generatedAt = nowIso();

  return ArgumentCatalogSchema.parse({
    binaryPath: argumentDocsDirectory,
    generatedAt,
    source: {
      kind: "help",
      command: ["arriero", "argument-registry"],
      hash: referenceCatalogHash(options),
      binarySize: 0,
      binaryModifiedAt: generatedAt,
    },
    cache: {
      hit: true,
      refreshed: false,
      stale: false,
    },
    options,
  });
}

type MemoizedMergedCatalog = {
  binarySize: number;
  binaryMtimeMs: string;
  parserId: ArgumentCatalogHelpParserId;
  registry: ReturnType<typeof loadArgumentRegistry> | null;
  catalog: Omit<ArgumentCatalog, "cache">;
};

const mergedCatalogMemo = new Map<string, MemoizedMergedCatalog>();

function sameRegistryEntries(
  left: ReturnType<typeof loadArgumentRegistry>,
  right: ReturnType<typeof loadArgumentRegistry>,
) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((entry, index) => entry === right[index]))
  );
}

function memoizedMergedCatalog(
  binaryPath: string,
  stat: ReturnType<typeof binaryStat>,
  parserId: ArgumentCatalogHelpParserId,
): ArgumentCatalog | null {
  const memo = mergedCatalogMemo.get(binaryPath);
  if (
    !memo ||
    memo.binarySize !== stat.binarySize ||
    memo.binaryMtimeMs !== stat.binaryMtimeMs ||
    memo.parserId !== parserId ||
    (memo.registry !== null &&
      !sameRegistryEntries(memo.registry, loadArgumentRegistry()))
  ) {
    return null;
  }
  return {
    ...memo.catalog,
    cache: { hit: true, refreshed: false, stale: false },
  };
}

function toCatalog(input: {
  binaryPath: string;
  cached: CachedArgumentCatalog;
  cache: ArgumentCatalog["cache"];
  parserId: ArgumentCatalogHelpParserId;
}): ArgumentCatalog {
  const registry =
    input.parserId === "llama-help" ? loadArgumentRegistry() : null;
  const options = registry
    ? applyArgumentHelp(
        mergeWithArgumentRegistry(input.cached.options, registry),
      )
    : input.cached.options;
  const catalog: Omit<ArgumentCatalog, "cache"> = {
    binaryPath: input.binaryPath,
    generatedAt: input.cached.generatedAt,
    source: {
      kind: "help",
      command: input.cached.helpHash.startsWith("fallback:")
        ? [
            "arriero",
            input.parserId === "sglang-help"
              ? "sglang-fallback-catalog"
              : "vllm-fallback-catalog",
          ]
        : helpCommand(input.binaryPath, input.parserId),
      hash: input.cached.helpHash,
      binarySize: input.cached.binarySize,
      binaryModifiedAt: input.cached.binaryModifiedAt,
    },
    options,
  };
  mergedCatalogMemo.set(input.binaryPath, {
    binarySize: input.cached.binarySize,
    binaryMtimeMs: input.cached.binaryMtimeMs,
    parserId: input.parserId,
    registry,
    catalog,
  });
  return { ...catalog, cache: input.cache };
}

function fallbackCatalog(parserId: ArgumentCatalogHelpParserId) {
  if (parserId === "vllm-help") {
    return {
      helpHash: vllmFallbackHelpHash,
      options: vllmFallbackArgumentOptions(),
    };
  }
  if (parserId === "sglang-help") {
    return {
      helpHash: sglangFallbackHelpHash,
      options: sglangFallbackArgumentOptions(),
    };
  }
  return null;
}

async function generateCatalogAsync(
  binaryPath: string,
  stat: ReturnType<typeof binaryStat>,
  parserId: ArgumentCatalogHelpParserId,
) {
  const invocation = helpInvocation(binaryPath, parserId);
  let helpHash: string;
  let options: ArgumentOption[];
  try {
    const helpOutput = await runHelpAsync(
      invocation.binaryPath,
      invocation.args,
      invocation.timeoutMs,
    );
    helpHash = createHash("sha256").update(helpOutput).digest("hex");
    options = HELP_PARSERS[parserId](helpOutput);
    if (options.length === 0)
      throw new Error("engine help contained no argument options");
  } catch (error) {
    const fallback = fallbackCatalog(parserId);
    if (!fallback) throw error;
    helpHash = fallback.helpHash;
    options = fallback.options;
  }
  const saved = saveArgumentCatalog({
    binaryPath,
    binarySize: stat.binarySize,
    binaryMtimeMs: stat.binaryMtimeMs,
    binaryModifiedAt: stat.binaryModifiedAt,
    helpHash,
    options,
    generatedAt: nowIso(),
    parserId,
  });
  writeArgumentCatalogSidecar(saved);
  return saved;
}

const catalogsInFlight = new Map<string, Promise<ArgumentCatalog>>();

export function getArgumentCatalogAsync(
  binaryPathInput?: string,
  input?: {
    refresh?: boolean;
    parserId?: ArgumentCatalogHelpParserId;
    docs?: boolean;
  },
): Promise<ArgumentCatalog> {
  const binaryPath = resolve(binaryPathInput || defaultBinaryPath());
  const parserId = input?.parserId ?? "llama-help";
  const refresh = input?.refresh ?? false;
  const docs = input?.docs ?? true;
  const key = `${binaryPath}|${parserId}|${refresh ? "refresh" : "cached"}`;
  let loading = catalogsInFlight.get(key);
  if (!loading) {
    loading = loadArgumentCatalog(binaryPath, parserId, refresh).finally(() => {
      catalogsInFlight.delete(key);
    });
    catalogsInFlight.set(key, loading);
  }
  return docs && parserId === "llama-help"
    ? loading.then((catalog) => ({
        ...catalog,
        options: withArgumentDocsAndCompatibility(catalog.options),
      }))
    : loading;
}

async function loadArgumentCatalog(
  binaryPath: string,
  parserId: ArgumentCatalogHelpParserId,
  refresh: boolean,
): Promise<ArgumentCatalog> {
  if (!existsSync(binaryPath)) {
    throw new Error(`engine binary not found: ${binaryPath}`);
  }
  const stat = binaryStat(binaryPath);
  if (!refresh) {
    const memoized = memoizedMergedCatalog(binaryPath, stat, parserId);
    if (memoized) {
      return memoized;
    }
  }
  const cached = getCachedArgumentCatalog(binaryPath);
  const stale = cached ? !isCacheCurrent(cached, stat, parserId) : false;
  if (cached && !stale && !refresh) {
    return toCatalog({
      binaryPath,
      cached,
      cache: { hit: true, refreshed: false, stale: false },
      parserId,
    });
  }
  if (!refresh) {
    const fromSidecar = readArgumentCatalogSidecar(binaryPath, stat);
    if (fromSidecar && isCacheCurrent(fromSidecar, stat, parserId)) {
      return toCatalog({
        binaryPath,
        cached: saveArgumentCatalog(fromSidecar),
        cache: { hit: true, refreshed: false, stale: false },
        parserId,
      });
    }
  }
  return toCatalog({
    binaryPath,
    cached: await generateCatalogAsync(binaryPath, stat, parserId),
    cache: { hit: false, refreshed: true, stale },
    parserId,
  });
}
