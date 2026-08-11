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
import { existsSync, readFileSync, statSync } from "node:fs";

import { readArgumentEngineeringDoc, withArgumentDocIndex } from "./docs.js";
import { argumentDocFiles } from "./docs-quality-lint.js";
import { engineArgumentContentPaths } from "./engine-content.js";
import { listEngineHelpSourceAdapters } from "./help-source-adapters.js";
import {
  engineArgumentSurfaceHash,
  parseEngineArgumentExtract,
} from "./help-source.js";

const booleanChoices = new Set([
  "on",
  "off",
  "auto",
  "0",
  "1",
  "true",
  "false",
]);

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

function readSnapshotMetadata(path: string) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<{
      entrypoint: string;
      commit: string;
      updatedAt: string;
    }>;
    return {
      entrypoint: parsed.entrypoint ?? null,
      commit: parsed.commit ?? null,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    return null;
  }
}

function readStoredExtract(engineId: string): {
  extract: EngineArgumentExtract;
  path: string;
  updatedAt: string;
} {
  const { snapshotPath } = engineArgumentContentPaths(engineId);
  if (!existsSync(snapshotPath)) {
    throw new Error(
      `stored argument extract not found for ${engineId}; run args:docs:source-sync -- --engine ${engineId} --write`,
    );
  }
  const parsed = parseEngineArgumentExtract(readFileSync(snapshotPath, "utf8"));
  if (!parsed.extract) {
    throw new Error(`stored argument extract for ${engineId}: ${parsed.error}`);
  }
  return {
    extract: parsed.extract,
    path: snapshotPath,
    updatedAt: statSync(snapshotPath).mtime.toISOString(),
  };
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
  if (allowedValues.length > 0) {
    return allowedValues.every((value) => booleanChoices.has(value))
      ? "boolean"
      : "enum";
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

function toArgumentOption(
  option: EngineArgumentDeclaration,
  engineName: string,
): ArgumentOption {
  const allowedValues = allowedValuesOf(option);
  const valueType = engineArgumentValueType(option);
  return {
    primaryName: option.flags[0]!,
    names: option.flags,
    category: option.group ?? "Other",
    valueHint: null,
    valueType,
    env: [],
    allowedValues,
    help: option.help,
    helpRu: `Оригинальная справка ${engineName}: ${option.help || option.flags[0]}`,
    helpRuSource: "fallback",
    doc: { exists: false, path: null, summary: null, updatedAt: null },
    control: {
      kind:
        valueType === "flag"
          ? "flag"
          : valueType === "boolean"
            ? "toggle"
            : valueType === "enum"
              ? "select"
              : valueType === "number"
                ? "number"
                : valueType === "path"
                  ? "path"
                  : valueType === "json"
                    ? "json"
                    : valueType === "list"
                      ? "csv-list"
                      : "text",
      cliEncoding: valueType === "flag" ? "flag" : "value",
      presetSupport: "supported",
    },
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

export function getEngineArgumentReferenceCatalog(
  engineId: string,
): ArgumentCatalog {
  const engine = referenceEngine(engineId);
  const stored = readStoredExtract(engineId);
  const { docsDirectory } = engineArgumentContentPaths(engineId);
  const options = withDocSummaries(
    stored.extract.options.map((option) =>
      toArgumentOption(option, engine.displayName),
    ),
    docsDirectory,
  );

  return ArgumentCatalogSchema.parse({
    binaryPath: stored.path,
    generatedAt: stored.updatedAt,
    source: {
      kind: "help",
      command: ["arriero", "engine-argument-extract", engineId],
      hash: engineArgumentSurfaceHash(stored.extract),
      binarySize: 0,
      binaryModifiedAt: stored.updatedAt,
    },
    cache: { hit: true, refreshed: false, stale: false },
    options,
  });
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
    const paths = engineArgumentContentPaths(engine.engineId);
    const metadata = readSnapshotMetadata(paths.metadataPath);
    let total: number | null = null;
    try {
      total = readStoredExtract(engine.engineId).extract.options.length;
    } catch {
      total = null;
    }
    return {
      ...engine,
      entrypoint: metadata?.entrypoint ?? null,
      commit: metadata?.commit ?? null,
      updatedAt: metadata?.updatedAt ?? null,
      total,
      documented: argumentDocFiles(paths.docsDirectory).length,
    };
  });
}
