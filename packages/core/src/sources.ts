import { z } from "zod";

import { BackgroundJobStatusSchema } from "./jobs.js";

export const SourceRepositoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const LLAMA_CPP_SOURCE_ID = "llama-cpp";

export const SourceRepositoryLocationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("managed") }),
  z.object({
    type: z.literal("external"),
    path: z.string().trim().min(1),
  }),
]);

export const SourceRepositorySpecSchema = z.object({
  id: SourceRepositoryIdSchema,
  adapter: z.string().trim().min(1).max(80),
  originUrl: z.string().trim().min(1).max(2048),
  location: SourceRepositoryLocationSchema,
});

export const SourceRepositorySettingsUpdateSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048),
});

export const SourceRepositoryCloneSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048).optional(),
  branch: z.string().trim().min(1).max(255).nullable().default(null),
});

export const SourceRepositoryStateSchema = z.enum([
  "missing",
  "busy",
  "ready",
  "dirty",
  "invalid",
  "error",
]);

export const SourceRepositoryStatusSchema = z.object({
  spec: SourceRepositorySpecSchema,
  displayName: z.string(),
  repoPath: z.string(),
  state: SourceRepositoryStateSchema,
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  valid: z.boolean(),
  currentCommit: z.string().nullable(),
  latestTag: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  originMatches: z.boolean().nullable(),
  dirty: z.boolean().nullable(),
  driftSupported: z.boolean(),
  activeOperation: z.string().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});

export const SourceRepositoryOperationResultSchema = z.object({
  operation: z.string(),
  output: z.string(),
  status: SourceRepositoryStatusSchema,
});

export const SourceRepositoryOperationKindSchema = z.enum(["clone", "pull"]);

export const SourceRepositoryOperationStatusSchema = BackgroundJobStatusSchema;

export const SourceRepositoryOperationPhaseSchema = z.enum([
  "starting",
  "receiving",
  "resolving",
  "checking-out",
  "validating",
  "publishing",
  "updating",
  "complete",
]);

export const SourceRepositoryOperationJobSchema = z.object({
  id: z.string().min(1),
  sourceId: SourceRepositoryIdSchema,
  operation: SourceRepositoryOperationKindSchema,
  status: SourceRepositoryOperationStatusSchema,
  phase: SourceRepositoryOperationPhaseSchema,
  progress: z.number().min(0).max(100).nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  logLines: z.array(z.string()),
});

export const SourceSyncDivergenceSchema = z.object({
  kind: z.string().min(1),
  severity: z.enum(["info", "warning"]),
  label: z.string(),
  detail: z.string().nullable(),
});

export const SourceSyncSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  sourcePath: z.string(),
  status: z.enum(["in-sync", "drift", "error"]),
  summary: z.string(),
  error: z.string().nullable(),
  divergences: z.array(SourceSyncDivergenceSchema),
});

export const SourceSyncReportStatusSchema = z.enum([
  "unavailable",
  "in-sync",
  "drift",
  "error",
]);

export const SourceSyncReportSchema = z.object({
  sourceId: SourceRepositoryIdSchema,
  status: SourceSyncReportStatusSchema,
  checkedAt: z.string(),
  repository: SourceRepositoryStatusSchema,
  repoPath: z.string(),
  commit: z.string().nullable(),
  sections: z.array(SourceSyncSectionSchema),
});

export const LlamaSourceSyncDivergenceSchema = SourceSyncDivergenceSchema;
export const LlamaSourceSyncSectionSchema = SourceSyncSectionSchema;
export const LlamaSourceSyncReportSchema = SourceSyncReportSchema.extend({
  llamaCppCommit: z.string().nullable(),
});

export type SourceRepositoryId = z.infer<typeof SourceRepositoryIdSchema>;
export type SourceRepositoryLocation = z.infer<
  typeof SourceRepositoryLocationSchema
>;
export type SourceRepositorySpec = z.infer<typeof SourceRepositorySpecSchema>;
export type SourceRepositorySettingsUpdate = z.infer<
  typeof SourceRepositorySettingsUpdateSchema
>;
export type SourceRepositoryClone = z.infer<typeof SourceRepositoryCloneSchema>;
export type SourceRepositoryState = z.infer<typeof SourceRepositoryStateSchema>;
export type SourceRepositoryStatus = z.infer<
  typeof SourceRepositoryStatusSchema
>;
export type SourceRepositoryOperationResult = z.infer<
  typeof SourceRepositoryOperationResultSchema
>;
export type SourceRepositoryOperationKind = z.infer<
  typeof SourceRepositoryOperationKindSchema
>;
export type SourceRepositoryOperationStatus = z.infer<
  typeof SourceRepositoryOperationStatusSchema
>;
export type SourceRepositoryOperationPhase = z.infer<
  typeof SourceRepositoryOperationPhaseSchema
>;
export type SourceRepositoryOperationJob = z.infer<
  typeof SourceRepositoryOperationJobSchema
>;
export type SourceSyncDivergence = z.infer<typeof SourceSyncDivergenceSchema>;
export type SourceSyncSection = z.infer<typeof SourceSyncSectionSchema>;
export type SourceSyncReportStatus = z.infer<
  typeof SourceSyncReportStatusSchema
>;
export type SourceSyncReport = z.infer<typeof SourceSyncReportSchema>;
export type LlamaSourceSyncDivergence = z.infer<
  typeof LlamaSourceSyncDivergenceSchema
>;
export type LlamaSourceSyncSection = z.infer<
  typeof LlamaSourceSyncSectionSchema
>;
export type LlamaSourceSyncReport = z.infer<typeof LlamaSourceSyncReportSchema>;
