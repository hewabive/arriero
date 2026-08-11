import { z } from "zod";

export const EngineArgumentDefaultSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("expression"), text: z.string().nullable() }),
]);

export const EngineArgumentValueTypeSchema = z.enum([
  "bool",
  "dict",
  "enum",
  "float",
  "int",
  "json",
  "list",
  "path",
  "str",
]);

export const EngineArgumentDeclarationSchema = z.object({
  flags: z.array(z.string()).min(1),
  group: z.string().nullable(),
  help: z.string(),
  choices: z.array(z.union([z.string(), z.number(), z.boolean()])).nullable(),
  type: EngineArgumentValueTypeSchema.nullable(),
  optional: z.boolean().optional(),
  default: EngineArgumentDefaultSchema.nullable(),
  action: z.string().nullable(),
  hidden: z.boolean(),
  origin: z.string(),
});

export const EngineArgumentExtractSchema = z.object({
  schema: z.literal(1),
  engine: z.string(),
  entrypoint: z.string(),
  sourceFiles: z.array(z.string()),
  options: z.array(EngineArgumentDeclarationSchema),
});

export const EngineHelpSourceKindSchema = z.enum([
  "help-block",
  "declaration-extract",
]);

export const EngineHelpSourceSignalSchema = z.enum([
  "content-hash",
  "commit-range",
  "none",
]);

export const EngineHelpSourceSnapshotSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  hash: z.string().nullable(),
  commit: z.string().nullable(),
  updatedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const EngineHelpSourceSyncSchema = z.object({
  engineId: z.string(),
  displayName: z.string(),
  kind: EngineHelpSourceKindSchema,
  sourceId: z.string(),
  sourcePaths: z.array(z.string()),
  snapshotPath: z.string(),
  metadataPath: z.string(),
  stored: EngineHelpSourceSnapshotSchema,
  current: EngineHelpSourceSnapshotSchema,
  inSync: z.boolean().nullable(),
  signal: EngineHelpSourceSignalSchema,
  pendingCommits: z.array(z.string()).nullable(),
});

export type EngineArgumentDefault = z.infer<typeof EngineArgumentDefaultSchema>;
export type EngineArgumentValueType = z.infer<
  typeof EngineArgumentValueTypeSchema
>;
export type EngineArgumentDeclaration = z.infer<
  typeof EngineArgumentDeclarationSchema
>;
export type EngineArgumentExtract = z.infer<typeof EngineArgumentExtractSchema>;
export type EngineHelpSourceKind = z.infer<typeof EngineHelpSourceKindSchema>;
export type EngineHelpSourceSignal = z.infer<
  typeof EngineHelpSourceSignalSchema
>;
export type EngineHelpSourceSnapshot = z.infer<
  typeof EngineHelpSourceSnapshotSchema
>;
export type EngineHelpSourceSync = z.infer<typeof EngineHelpSourceSyncSchema>;
