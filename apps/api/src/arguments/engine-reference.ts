import {
  ArgumentCatalogSchema,
  type ArgumentCatalog,
  type ArgumentOption,
  type ArgumentValueType,
  type EngineArgumentDeclaration,
  type EngineArgumentExtract,
  type EngineArgumentValueType,
  type LlamaArgumentEngineeringDoc,
} from "@arriero/core";

import {
  argumentDocFiles,
  readArgumentEngineeringDoc,
  withArgumentDocIndex,
} from "./docs.js";
import {
  engineArgumentContentPaths,
  readEngineExtractMetadata,
  readStoredEngineExtract,
  type StoredEngineExtract,
} from "./engine-content.js";
import { listEngineHelpSourceAdapters } from "./help-source-adapters.js";
import { engineArgumentSurfaceHash, nowIso } from "./help-source.js";
import { defaultArgumentControl } from "./registry.js";
import { valueTypeFromChoices } from "./value-type.js";

export function listEngineArgumentReferences() {
  return listEngineHelpSourceAdapters()
    .filter((adapter) => adapter.kind === "declaration-extract")
    .map((adapter) => ({
      engineId: adapter.id,
      displayName: adapter.displayName,
    }));
}

function referenceEngine(engineId: string) {
  const engine = listEngineArgumentReferences().find(
    (item) => item.engineId === engineId,
  );
  if (!engine) {
    throw new Error(`unknown engine argument reference: ${engineId}`);
  }
  return engine;
}

function requireStoredExtract(
  engineId: string,
): StoredEngineExtract & { extract: EngineArgumentExtract } {
  const stored = readStoredEngineExtract(engineId);
  if (!stored.extract) {
    throw new Error(
      stored.exists
        ? `stored argument extract for ${engineId}: ${stored.error}`
        : `stored argument extract not found for ${engineId}; run args:docs:source-sync -- --engine ${engineId} --write`,
    );
  }
  return { ...stored, extract: stored.extract };
}

function allowedValuesOf(option: EngineArgumentDeclaration) {
  return (option.choices ?? []).map((value) => String(value));
}

function argparseActionName(action: string | null) {
  if (!action) {
    return null;
  }
  const unquoted = action.replace(/^['"]|['"]$/g, "");
  return unquoted.slice(unquoted.lastIndexOf(".") + 1);
}

const bareFlagAction = /store_?(true|false|const)/i;

function declaredValueType(
  declared: EngineArgumentValueType | null,
): ArgumentValueType | null {
  switch (declared) {
    case "int":
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "path":
      return "path";
    case "dict":
    case "json":
      return "json";
    case "list":
      return "list";
    default:
      return null;
  }
}

export function engineArgumentValueType(
  option: EngineArgumentDeclaration,
): ArgumentValueType {
  const allowedValues = allowedValuesOf(option);
  const action = argparseActionName(option.action);
  if (action && bareFlagAction.test(action)) {
    return "flag";
  }
  if (action === "BooleanOptionalAction") {
    return "boolean";
  }
  const fromChoices = valueTypeFromChoices(allowedValues);
  if (fromChoices) {
    return fromChoices;
  }
  const declared = declaredValueType(option.type);
  if (declared) {
    return declared;
  }

  const literal =
    option.default?.kind === "literal" ? option.default.value : undefined;
  if (typeof literal === "boolean") return "boolean";
  if (typeof literal === "number") return "number";
  if (Array.isArray(literal)) return "list";
  if (literal !== null && typeof literal === "object") return "json";

  const name = option.flags[0] ?? "";
  if (/(^|-)(path|dir|directory|file)(-|$)/.test(name.replace(/^-+/, ""))) {
    return "path";
  }
  if (/\bjson\b/i.test(option.help)) return "json";
  if (/comma[- ]separated/i.test(option.help)) return "list";
  return "string";
}

function literalDefaultValue(option: EngineArgumentDeclaration): string | null {
  if (option.default?.kind !== "literal") {
    return null;
  }
  const value = option.default.value;
  if (value === null || value === undefined) {
    return null;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered ? rendered : null;
}

export function toArgumentOption(
  option: EngineArgumentDeclaration,
  engineName: string,
): ArgumentOption {
  const allowedValues = allowedValuesOf(option);
  const valueType = engineArgumentValueType(option);
  const primaryName = option.flags[0]!;
  return {
    primaryName,
    names: option.flags,
    category: option.group ?? "Other",
    valueHint: null,
    valueType,
    env: [],
    allowedValues,
    defaultValue: literalDefaultValue(option),
    help: option.help,
    helpRu: `Оригинальная справка ${engineName}: ${option.help || primaryName}`,
    helpRuSource: "fallback",
    doc: { exists: false, path: null, summary: null, updatedAt: null },
    control: defaultArgumentControl({ primaryName, valueType, allowedValues }),
    compatibility: {
      metadataSource: "registry",
      presentInBinary: false,
      binaryPrimaryName: null,
      binaryNames: [],
    },
    deprecated: /\bdeprecated\b/i.test(option.help),
  };
}

function withDocSummaries(options: ArgumentOption[], docsDirectory: string) {
  return withArgumentDocIndex(options, docsDirectory).map((option) =>
    option.doc.exists && option.doc.summary
      ? {
          ...option,
          helpRu: option.doc.summary,
          helpRuSource: "registry" as const,
        }
      : option,
  );
}

const CATALOG_CACHE_TTL_MS = 5_000;

const catalogCache = new Map<
  string,
  { catalog: ArgumentCatalog; expiresAt: number }
>();

export function getEngineArgumentReferenceCatalog(
  engineId: string,
): ArgumentCatalog {
  const now = Date.now();
  const cached = catalogCache.get(engineId);
  if (cached && cached.expiresAt > now) {
    return cached.catalog;
  }

  const engine = referenceEngine(engineId);
  const stored = requireStoredExtract(engineId);
  const { docsDirectory } = engineArgumentContentPaths(engineId);
  const options = withDocSummaries(
    stored.extract.options.map((option) =>
      toArgumentOption(option, engine.displayName),
    ),
    docsDirectory,
  );
  const generatedAt = stored.updatedAt ?? nowIso();

  const catalog = ArgumentCatalogSchema.parse({
    binaryPath: stored.path,
    generatedAt,
    source: {
      kind: "help",
      command: ["arriero", "engine-argument-extract", engineId],
      hash: engineArgumentSurfaceHash(stored.extract),
      binarySize: 0,
      binaryModifiedAt: generatedAt,
    },
    cache: { hit: true, refreshed: false, stale: false },
    options,
  });
  catalogCache.set(engineId, {
    catalog,
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  });
  return catalog;
}

export function readEngineArgumentDoc(
  engineId: string,
  primaryName: string,
): LlamaArgumentEngineeringDoc {
  referenceEngine(engineId);
  return readArgumentEngineeringDoc({
    primaryName,
    directory: engineArgumentContentPaths(engineId).docsDirectory,
  });
}

export function engineArgumentReferenceSummaries() {
  return listEngineArgumentReferences().map((engine) => {
    const metadata = readEngineExtractMetadata(engine.engineId);
    const stored = readStoredEngineExtract(engine.engineId);
    return {
      ...engine,
      entrypoint:
        typeof metadata?.entrypoint === "string" ? metadata.entrypoint : null,
      commit: typeof metadata?.commit === "string" ? metadata.commit : null,
      updatedAt:
        typeof metadata?.updatedAt === "string" ? metadata.updatedAt : null,
      total: stored.extract?.options.length ?? null,
      documented: argumentDocFiles(
        engineArgumentContentPaths(engine.engineId).docsDirectory,
      ).length,
    };
  });
}
