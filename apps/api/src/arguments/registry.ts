import type {
  ArgumentCliEncoding,
  ArgumentControl,
  ArgumentControlKind,
  ArgumentOption,
  LlamaArgumentPresetSupport,
  ArgumentValueType,
} from "@arriero/core";
import {
  ArgumentCliEncodingSchema,
  ArgumentControlKindSchema,
  LlamaArgumentPresetSupportSchema,
  ArgumentValueTypeSchema,
} from "@arriero/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  argumentDocsDirectory,
  argumentDocSlug,
  parseArgumentDocFile,
} from "./docs.js";

type ArgumentRegistryEntry = {
  option: ArgumentOption;
  slug: string;
};

const emptyDoc = {
  exists: false,
  path: null,
  summary: null,
  updatedAt: null,
};

function stringField(frontmatter: Record<string, unknown>, key: string) {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayField(frontmatter: Record<string, unknown>, key: string) {
  const value = frontmatter[key];
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function enumField<T extends string>(
  value: string | null,
  parse: (value: unknown) => { success: boolean; data?: T },
  fallback: T,
) {
  if (!value) {
    return fallback;
  }
  const parsed = parse(value);
  return parsed.success && parsed.data ? parsed.data : fallback;
}

function controlKindForValueType(
  valueType: ArgumentValueType,
  allowedValues: string[],
  primaryName: string,
): ArgumentControlKind {
  if (primaryName.includes("api-key")) return "secret";
  if (valueType === "flag") return "flag";
  if (valueType === "boolean") {
    return allowedValues.length > 0 ? "select" : "toggle";
  }
  if (valueType === "enum") return "select";
  if (valueType === "number") return "number";
  if (valueType === "path") return "path";
  if (valueType === "json") return "json";
  if (valueType === "list") return "csv-list";
  return "text";
}

function cliEncodingForValueType(
  valueType: ArgumentValueType,
): ArgumentCliEncoding {
  if (valueType === "flag") return "flag";
  if (valueType === "list") return "csv";
  return "value";
}

function defaultPresetSupport(): LlamaArgumentPresetSupport {
  return "supported";
}

export function defaultArgumentControl(input: {
  primaryName: string;
  valueType: ArgumentValueType;
  allowedValues: string[];
}): ArgumentControl {
  return {
    kind: controlKindForValueType(
      input.valueType,
      input.allowedValues,
      input.primaryName,
    ),
    cliEncoding: cliEncodingForValueType(input.valueType),
    presetSupport: defaultPresetSupport(),
  };
}

function controlFromFrontmatter(input: {
  frontmatter: Record<string, unknown>;
  primaryName: string;
  valueType: ArgumentValueType;
  allowedValues: string[];
}): ArgumentControl {
  const kind = enumField(
    stringField(input.frontmatter, "controlKind"),
    (value) => ArgumentControlKindSchema.safeParse(value),
    defaultArgumentControl(input).kind,
  );
  const cliEncoding = enumField(
    stringField(input.frontmatter, "cliEncoding"),
    (value) => ArgumentCliEncodingSchema.safeParse(value),
    defaultArgumentControl(input).cliEncoding,
  );
  const presetSupport = enumField(
    stringField(input.frontmatter, "presetSupport"),
    (value) => LlamaArgumentPresetSupportSchema.safeParse(value),
    defaultArgumentControl(input).presetSupport,
  );

  return { kind, cliEncoding, presetSupport };
}

function registryOnlyOptionIsRuntimeSupported(input: {
  primaryName: string;
  control: ArgumentControl;
}) {
  return (
    !input.primaryName.startsWith("-") &&
    (input.control.presetSupport === "preset-only" ||
      input.control.presetSupport === "model-managed")
  );
}

export function optionFromArgumentDocFrontmatter(
  frontmatter: Record<string, unknown>,
): ArgumentOption | null {
  const primaryName = stringField(frontmatter, "primaryName");
  if (!primaryName) {
    return null;
  }

  const valueType = enumField(
    stringField(frontmatter, "valueType"),
    (value) => ArgumentValueTypeSchema.safeParse(value),
    "string",
  );
  const aliases = stringArrayField(frontmatter, "aliases");
  const names = Array.from(new Set([primaryName, ...aliases]));
  const allowedValues = stringArrayField(frontmatter, "allowedValues");
  const summary = stringField(frontmatter, "summary");
  const control = controlFromFrontmatter({
    frontmatter,
    primaryName,
    valueType,
    allowedValues,
  });
  const runtimeSupported = registryOnlyOptionIsRuntimeSupported({
    primaryName,
    control,
  });

  return {
    primaryName,
    names,
    category: stringField(frontmatter, "category") ?? "llama.cpp",
    valueHint: stringField(frontmatter, "valueHint"),
    valueType,
    env: stringArrayField(frontmatter, "env"),
    allowedValues,
    help: summary ?? "",
    helpRu: summary ?? `См. инженерную справку для ${primaryName}.`,
    helpRuSource: "registry",
    doc: emptyDoc,
    control,
    compatibility: {
      metadataSource: "registry",
      presentInBinary: runtimeSupported,
      binaryPrimaryName: null,
      binaryNames: [],
    },
    deprecated: false,
  };
}

const REGISTRY_CACHE_TTL_MS = 5_000;

let registryCache: {
  entries: ArgumentRegistryEntry[];
  expiresAt: number;
} | null = null;

export function loadArgumentRegistry() {
  const now = Date.now();
  if (registryCache && registryCache.expiresAt > now) {
    return registryCache.entries;
  }

  const entries: ArgumentRegistryEntry[] = [];
  if (existsSync(argumentDocsDirectory)) {
    for (const item of readdirSync(argumentDocsDirectory, {
      withFileTypes: true,
    })) {
      if (
        !item.isFile() ||
        !item.name.endsWith(".md") ||
        item.name[0] === "_"
      ) {
        continue;
      }

      const path = join(argumentDocsDirectory, item.name);
      const parsed = parseArgumentDocFile(readFileSync(path, "utf8"));
      const option = optionFromArgumentDocFrontmatter(parsed.frontmatter);
      if (!option) {
        continue;
      }

      entries.push({
        option,
        slug: item.name.replace(/\.md$/, ""),
      });
    }
  }

  entries.sort((left, right) =>
    left.option.primaryName.localeCompare(right.option.primaryName),
  );
  registryCache = { entries, expiresAt: now + REGISTRY_CACHE_TTL_MS };
  return entries;
}

export function registryNameMap(entries = loadArgumentRegistry()) {
  const map = new Map<string, ArgumentRegistryEntry>();
  for (const entry of entries) {
    map.set(entry.option.primaryName, entry);
    map.set(argumentDocSlug(entry.option.primaryName), entry);
    for (const name of entry.option.names) {
      map.set(name, entry);
      map.set(name.replace(/^-+/, ""), entry);
    }
    for (const env of entry.option.env) {
      map.set(env, entry);
    }
  }
  return map;
}
