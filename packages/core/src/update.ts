import { z } from "zod";

import { BackgroundJobStatusSchema } from "./jobs.js";

export const AppRunModeSchema = z.enum(["serve", "dev", "unknown"]);

export const AppVersionSchema = z.object({
  commit: z.string().nullable(),
  shortCommit: z.string().nullable(),
  committedAt: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  isGitRepo: z.boolean(),
  mode: AppRunModeSchema,
  supervised: z.boolean(),
  canUpdate: z.boolean(),
  updateBlockedReason: z.string().nullable(),
  behindCount: z.number().int().nullable(),
  upstreamCommit: z.string().nullable(),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  startedAt: z.string().nullable().default(null),
});

export const AppRestartResultSchema = z.object({
  restarting: z.boolean(),
  startedAt: z.string().nullable(),
});

export const UpdateJobStatusSchema = BackgroundJobStatusSchema;
export const UpdateJobStepNameSchema = z.enum([
  "snapshot",
  "git-pull",
  "install",
  "build",
  "restart",
]);
export const UpdateJobStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const UpdateJobStepSchema = z.object({
  name: UpdateJobStepNameSchema,
  status: UpdateJobStepStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
});

export const UpdateJobSchema = z.object({
  id: z.string(),
  status: UpdateJobStatusSchema,
  steps: z.array(UpdateJobStepSchema),
  currentStep: UpdateJobStepNameSchema.nullable(),
  fromCommit: z.string().nullable(),
  toCommit: z.string().nullable(),
  willRestart: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logPath: z.string(),
  error: z.string().nullable(),
});

export const UpdateJobStartSchema = z.object({
  restart: z.boolean().default(true),
});

export const UpdateLogTailSchema = z.object({
  jobId: z.string(),
  logPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export const UpdateUpstreamSchema = z.object({
  commit: z.string(),
  shortCommit: z.string(),
  committedAt: z.string().nullable(),
  ref: z.string().nullable(),
  lastCheckedAt: z.string(),
});

export const UpdateFleetNodeSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  self: z.boolean(),
  baseUrl: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  version: AppVersionSchema.nullable(),
  outdated: z.boolean(),
  behindCount: z.number().int().nullable(),
});

export const UpdateFleetSchema = z.object({
  upstream: UpdateUpstreamSchema.nullable(),
  nodes: z.array(UpdateFleetNodeSchema),
});

export type AppRunMode = z.infer<typeof AppRunModeSchema>;
export type AppVersion = z.infer<typeof AppVersionSchema>;
export type AppRestartResult = z.infer<typeof AppRestartResultSchema>;
export type UpdateJobStatus = z.infer<typeof UpdateJobStatusSchema>;
export type UpdateJobStepName = z.infer<typeof UpdateJobStepNameSchema>;
export type UpdateJobStepStatus = z.infer<typeof UpdateJobStepStatusSchema>;
export type UpdateJobStep = z.infer<typeof UpdateJobStepSchema>;
export type UpdateJob = z.infer<typeof UpdateJobSchema>;
export type UpdateJobStart = z.infer<typeof UpdateJobStartSchema>;
export type UpdateLogTail = z.infer<typeof UpdateLogTailSchema>;
export type UpdateUpstream = z.infer<typeof UpdateUpstreamSchema>;
export type UpdateFleetNode = z.infer<typeof UpdateFleetNodeSchema>;
export type UpdateFleet = z.infer<typeof UpdateFleetSchema>;
