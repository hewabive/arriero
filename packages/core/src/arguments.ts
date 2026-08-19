import { z } from "zod";

import { EngineHelpSourceSnapshotSchema } from "./engine-args.js";
import {
  engineDescriptor,
  type EngineArgumentCatalogParserId,
  type InstanceKind,
} from "./engine-descriptor.js";
import { LlamaSourceStatusSchema } from "./llama.js";

export const ArgumentValueTypeSchema = z.enum([
  "flag",
  "boolean",
  "number",
  "string",
  "path",
  "json",
  "enum",
  "list",
]);

export const ArgumentControlKindSchema = z.enum([
  "flag",
  "toggle",
  "select",
  "number",
  "text",
  "path",
  "json",
  "csv-list",
  "secret",
  "two-values",
]);

export const ArgumentCliEncodingSchema = z.enum([
  "flag",
  "value",
  "csv",
  "repeated",
  "two-values",
]);

export const LlamaArgumentPresetSupportSchema = z.enum([
  "supported",
  "unsupported",
  "preset-only",
  "model-managed",
  "router-managed",
]);

export const ArgumentControlSchema = z
  .object({
    kind: ArgumentControlKindSchema,
    cliEncoding: ArgumentCliEncodingSchema,
    presetSupport: LlamaArgumentPresetSupportSchema,
  })
  .default({
    kind: "text",
    cliEncoding: "value",
    presetSupport: "supported",
  });

export const LlamaArgumentCompatibilitySchema = z
  .object({
    metadataSource: z.enum(["registry", "binary"]),
    presentInBinary: z.boolean(),
    binaryPrimaryName: z.string().nullable(),
    binaryNames: z.array(z.string()),
  })
  .default({
    metadataSource: "binary",
    presentInBinary: true,
    binaryPrimaryName: null,
    binaryNames: [],
  });

export const LlamaArgumentDocIndexSchema = z
  .object({
    exists: z.boolean().default(false),
    path: z.string().nullable().default(null),
    summary: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .default({
    exists: false,
    path: null,
    summary: null,
    updatedAt: null,
  });

export const ArgumentOptionSchema = z.object({
  primaryName: z.string(),
  names: z.array(z.string()),
  category: z.string(),
  valueHint: z.string().nullable(),
  valueType: ArgumentValueTypeSchema,
  env: z.array(z.string()),
  allowedValues: z.array(z.string()),
  defaultValue: z.string().nullable().default(null),
  help: z.string(),
  helpRu: z.string(),
  helpRuSource: z.enum(["registry", "builtin", "fallback"]),
  doc: LlamaArgumentDocIndexSchema,
  control: ArgumentControlSchema,
  compatibility: LlamaArgumentCompatibilitySchema,
  deprecated: z.boolean(),
});

export const ArgumentCatalogSchema = z.object({
  binaryPath: z.string(),
  generatedAt: z.string(),
  source: z.object({
    kind: z.literal("help"),
    command: z.array(z.string()),
    hash: z.string(),
    binarySize: z.number(),
    binaryModifiedAt: z.string(),
  }),
  cache: z.object({
    hit: z.boolean(),
    refreshed: z.boolean(),
    stale: z.boolean(),
  }),
  options: z.array(ArgumentOptionSchema),
});

export const ArgumentDefaultValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "flag",
  "list",
  "null",
]);

export const ArgumentDefaultSchema = z.object({
  key: z.string().min(1),
  value: z.string().default(""),
  valueType: ArgumentDefaultValueTypeSchema.default("string"),
});

export const ArgumentDefaultsSchema = z.object({
  instance: z.array(ArgumentDefaultSchema).default([]),
  engines: z.record(z.string(), z.array(ArgumentDefaultSchema)).default({}),
  updatedAt: z.string().nullable().default(null),
});

const DEFAULTS_SECTION_BY_CATALOG_PARSER: Record<
  EngineArgumentCatalogParserId,
  "instance" | { engine: string } | null
> = {
  "llama-help": "instance",
  "vllm-help": { engine: "vllm" },
  "sglang-help": { engine: "sglang" },
  none: null,
};

export function argumentDefaultsSection(
  defaults: Pick<ArgumentDefaults, "instance" | "engines">,
  engineId: string | null,
): ArgumentDefault[] {
  return engineId === null
    ? defaults.instance
    : (defaults.engines[engineId] ?? []);
}

export function argumentDefaultsForKind(
  defaults: Pick<ArgumentDefaults, "instance" | "engines">,
  kind: InstanceKind,
): ArgumentDefault[] {
  const section =
    DEFAULTS_SECTION_BY_CATALOG_PARSER[
      engineDescriptor(kind).preflight.argumentCatalogParser
    ];
  if (section === null) {
    return [];
  }
  return section === "instance"
    ? defaults.instance
    : (defaults.engines[section.engine] ?? []);
}

export const LlamaArgumentEngineeringDocSchema = z.object({
  primaryName: z.string(),
  path: z.string(),
  exists: z.boolean(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  updatedAt: z.string().nullable(),
  frontmatter: z.record(z.string(), z.unknown()),
  markdown: z.string(),
});

export const LlamaArgumentHelpSourceSnapshotSchema =
  EngineHelpSourceSnapshotSchema.omit({ commit: true }).extend({
    llamaCppCommit: z.string().nullable(),
  });

export const LlamaArgumentHelpSourceSyncSchema = z.object({
  sourcePath: z.string(),
  block: z.string(),
  snapshotPath: z.string(),
  metadataPath: z.string(),
  stored: LlamaArgumentHelpSourceSnapshotSchema,
  current: LlamaArgumentHelpSourceSnapshotSchema,
  inSync: z.boolean().nullable(),
  phantomRows: z.array(z.string()).nullable(),
});

export const LlamaArgumentDocsSyncReportSchema = z.object({
  checkedAt: z.string(),
  source: LlamaSourceStatusSchema,
  helpSource: LlamaArgumentHelpSourceSyncSchema,
  docsDirectory: z.string(),
});

export const LlamaArgumentHelpDiffSchema = z.object({
  diff: z.string(),
});

export type LlamaArgumentHelpSourceSnapshot = z.infer<
  typeof LlamaArgumentHelpSourceSnapshotSchema
>;
export type LlamaArgumentHelpSourceSync = z.infer<
  typeof LlamaArgumentHelpSourceSyncSchema
>;
export type LlamaArgumentDocsSyncReport = z.infer<
  typeof LlamaArgumentDocsSyncReportSchema
>;
export type LlamaArgumentHelpDiff = z.infer<typeof LlamaArgumentHelpDiffSchema>;
export type ArgumentValueType = z.infer<typeof ArgumentValueTypeSchema>;
export type ArgumentControlKind = z.infer<typeof ArgumentControlKindSchema>;
export type ArgumentCliEncoding = z.infer<typeof ArgumentCliEncodingSchema>;
export type LlamaArgumentPresetSupport = z.infer<
  typeof LlamaArgumentPresetSupportSchema
>;
export type ArgumentControl = z.infer<typeof ArgumentControlSchema>;
export type LlamaArgumentCompatibility = z.infer<
  typeof LlamaArgumentCompatibilitySchema
>;
export type LlamaArgumentDocIndex = z.infer<typeof LlamaArgumentDocIndexSchema>;
export type ArgumentOption = z.infer<typeof ArgumentOptionSchema>;
export type ArgumentCatalog = z.infer<typeof ArgumentCatalogSchema>;
export type ArgumentDefaultValueType = z.infer<
  typeof ArgumentDefaultValueTypeSchema
>;
export type ArgumentDefault = z.infer<typeof ArgumentDefaultSchema>;
export type ArgumentDefaults = z.infer<typeof ArgumentDefaultsSchema>;
export type LlamaArgumentEngineeringDoc = z.infer<
  typeof LlamaArgumentEngineeringDocSchema
>;
