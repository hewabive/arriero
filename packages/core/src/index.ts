import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { ModelScanSettingsSchema } from "./models.js";
import { SourceRepositorySpecSchema } from "./sources.js";

export * from "./engine-descriptor.js";
export * from "./ggml.js";
export * from "./instance-resources.js";
export * from "./memory-assessment.js";
export * from "./memory-estimate.js";
export * from "./proxy/request-edits.js";
export * from "./proxy/pipeline-graph.js";
export * from "./proxy/text-replacement.js";
export * from "./proxy/token-scale.js";
export * from "./resources.js";
export * from "./llama.js";
export * from "./instance.js";
export * from "./path-catalog.js";
export * from "./process.js";
export * from "./api-endpoints.js";
export * from "./proxy/pipeline-nodes.js";
export * from "./proxy/api-proxy.js";
export * from "./instance-health.js";
export * from "./filesystem.js";
export * from "./jobs.js";
export * from "./sources.js";
export * from "./build.js";
export * from "./environments.js";
export * from "./update.js";
export * from "./config-git.js";
export * from "./arguments.js";
export * from "./system.js";
export * from "./prerequisites.js";
export * from "./fleet.js";
export * from "./public-status.js";
export * from "./models.js";

export const PresetNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const AppSettingsFileSchema = z
  .object({
    modelScan: ModelScanSettingsSchema.optional(),
    sourceRepositories: z.array(SourceRepositorySpecSchema).optional(),
    llamaSource: LlamaSourceSettingsSchema.optional(),
    build: BuildSettingsSchema.omit({ repoPath: true }).optional(),
    environments: EnvironmentRepositorySettingsSchema.optional(),
  })
  .default({});

export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;

export const ModelPresetEntrySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  modelPath: z.string(),
  mmprojPath: z.string().nullable(),
  extraArgs: z.record(z.string(), z.string()).default({}),
});

export const ModelPresetFileSchema = z.object({
  globalArgs: z.record(z.string(), z.string()).default({}),
  rootArgs: z.record(z.string(), z.string()).default({}),
  entries: z.array(ModelPresetEntrySchema).default([]),
});

export const PresetDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  section: z.string().nullable(),
  key: z.string().nullable(),
  line: z.number().int().nullable(),
});

export const ModelPresetSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  mtimeMs: z.number().nullable(),
});

export const PresetValidationSchema = z.object({
  name: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
});

export const ModelPresetDocumentSchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
  file: ModelPresetFileSchema,
  content: z.string(),
  mtimeMs: z.number().nullable(),
});

export const ModelPresetWriteSchema = z.object({
  content: z.string(),
  expectedMtimeMs: z.number().nullable(),
  force: z.boolean().default(false),
});

export const ModelPresetCreateSchema = z.object({
  name: PresetNameSchema,
});

export type ModelPresetEntry = z.infer<typeof ModelPresetEntrySchema>;
export type ModelPresetFile = z.infer<typeof ModelPresetFileSchema>;
export type PresetDiagnostic = z.infer<typeof PresetDiagnosticSchema>;
export type ModelPresetSummary = z.infer<typeof ModelPresetSummarySchema>;
export type PresetValidation = z.infer<typeof PresetValidationSchema>;
export type ModelPresetDocument = z.infer<typeof ModelPresetDocumentSchema>;
export type ModelPresetWrite = z.infer<typeof ModelPresetWriteSchema>;
export type ModelPresetCreate = z.infer<typeof ModelPresetCreateSchema>;
