import type {
  EngineArgumentCatalogParserId,
  ArgumentCatalog,
  ArgumentOption,
} from "@llama-manager/core";
import { ArgumentCatalogSchema } from "@llama-manager/core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
import { binaryStat, defaultBinaryPath, runHelp } from "./binary-discovery.js";
import {
  readArgumentCatalogSidecar,
  writeArgumentCatalogSidecar,
} from "./sidecar.js";
import { parseLlamaArgumentOptions } from "./help-parser.js";
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
};

function nowIso() {
  return new Date().toISOString();
}

function isCacheCurrent(
  cached: CachedArgumentCatalog,
  stat: ReturnType<typeof binaryStat>,
  parserId: ArgumentCatalogHelpParserId,
) {
  return (
    cached.binarySize === stat.binarySize &&
    cached.binaryMtimeMs === stat.binaryMtimeMs &&
    cached.parserId === parserId
  );
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
): ArgumentOption[] {
  const registry = loadArgumentRegistry();
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
      command: ["llama-manager", "argument-registry"],
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

function toCatalog(input: {
  binaryPath: string;
  cached: CachedArgumentCatalog;
  cache: ArgumentCatalog["cache"];
}): ArgumentCatalog {
  return {
    binaryPath: input.binaryPath,
    generatedAt: input.cached.generatedAt,
    source: {
      kind: "help",
      command: [input.binaryPath, "--help"],
      hash: input.cached.helpHash,
      binarySize: input.cached.binarySize,
      binaryModifiedAt: input.cached.binaryModifiedAt,
    },
    cache: input.cache,
    options: withArgumentDocsAndCompatibility(
      applyArgumentHelp(mergeWithArgumentRegistry(input.cached.options)),
    ),
  };
}

function generateCatalog(
  binaryPath: string,
  stat: ReturnType<typeof binaryStat>,
  parserId: ArgumentCatalogHelpParserId,
) {
  const helpOutput = runHelp(binaryPath);
  const helpHash = createHash("sha256").update(helpOutput).digest("hex");
  const options = HELP_PARSERS[parserId](helpOutput);

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

export function getArgumentCatalog(
  binaryPathInput?: string,
  input?: { refresh?: boolean; parserId?: ArgumentCatalogHelpParserId },
): ArgumentCatalog {
  const binaryPath = resolve(binaryPathInput || defaultBinaryPath());
  if (!existsSync(binaryPath)) {
    throw new Error(`llama-server binary not found: ${binaryPath}`);
  }

  const parserId = input?.parserId ?? "llama-help";
  const stat = binaryStat(binaryPath);
  const cached = getCachedArgumentCatalog(binaryPath);
  const stale = cached ? !isCacheCurrent(cached, stat, parserId) : false;

  if (cached && !stale && !input?.refresh) {
    return toCatalog({
      binaryPath,
      cached,
      cache: { hit: true, refreshed: false, stale: false },
    });
  }

  if (!input?.refresh) {
    const fromSidecar = readArgumentCatalogSidecar(binaryPath, stat);
    if (fromSidecar && fromSidecar.parserId === parserId) {
      return toCatalog({
        binaryPath,
        cached: saveArgumentCatalog(fromSidecar),
        cache: { hit: true, refreshed: false, stale: false },
      });
    }
  }

  return toCatalog({
    binaryPath,
    cached: generateCatalog(binaryPath, stat, parserId),
    cache: { hit: false, refreshed: true, stale },
  });
}
