import { z } from "zod";

import { BackgroundJobStatusSchema } from "./jobs.js";

export const BuildProfileSchema = z.enum(["server", "full"]);
export const CmakeBooleanModeSchema = z.enum(["default", "on", "off"]);

export const BuildSettingsSchema = z.object({
  repoPath: z.string().min(1),
  buildDir: z.string().min(1),
  buildType: z.enum(["Release", "Debug", "RelWithDebInfo", "MinSizeRel"]),
  buildProfile: BuildProfileSchema.default("server"),
  cuda: z.boolean(),
  rpc: z.boolean().default(false),
  native: z.boolean(),
  cudaArchitectures: z.string().trim().min(1).nullable().default(null),
  cudaFaAllQuants: z.boolean().default(false),
  cudaGraphs: CmakeBooleanModeSchema.default("default"),
  cudaNoVmm: z.boolean().default(false),
  llguidance: CmakeBooleanModeSchema.default("default"),
  extraCmakeArgs: z.array(z.string()),
  env: z.record(z.string(), z.string()).default({}),
  target: z.string(),
  parallelJobs: z.number().int().positive().max(256).nullable(),
});

export const BuildJobStatusSchema = BackgroundJobStatusSchema;
export const BuildJobStepNameSchema = z.enum([
  "git-checkout",
  "git-pull",
  "ui-install",
  "clean-build-dir",
  "configure",
  "build",
  "build-fit-params",
  "build-rpc-server",
]);
export const BuildJobStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "warning",
  "failed",
  "skipped",
]);

export const BuildJobStepSchema = z.object({
  name: BuildJobStepNameSchema,
  status: BuildJobStepStatusSchema,
  command: z.array(z.string()),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
});

export const BuildJobSchema = z.object({
  id: z.string(),
  status: BuildJobStatusSchema,
  settings: BuildSettingsSchema,
  steps: z.array(BuildJobStepSchema),
  currentStep: BuildJobStepNameSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  logPath: z.string(),
  binaryPath: z.string().nullable(),
  error: z.string().nullable(),
});

export const BuildJobStartSchema = z.object({
  settings: BuildSettingsSchema.optional(),
  gitRef: z.string().trim().min(1).nullable().default(null),
  pull: z.boolean().default(true),
  installUiDeps: z.boolean().default(true),
  cleanBuildDir: z.boolean().default(false),
  configure: z.boolean().default(true),
  build: z.boolean().default(true),
});

export const BuildLogTailSchema = z.object({
  jobId: z.string(),
  logPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export type BuildSettings = z.infer<typeof BuildSettingsSchema>;
export type BuildJobStatus = z.infer<typeof BuildJobStatusSchema>;
export type BuildJobStepName = z.infer<typeof BuildJobStepNameSchema>;
export type BuildJobStepStatus = z.infer<typeof BuildJobStepStatusSchema>;
export type BuildJobStep = z.infer<typeof BuildJobStepSchema>;
export type BuildJob = z.infer<typeof BuildJobSchema>;
export type BuildJobStart = z.infer<typeof BuildJobStartSchema>;
export type BuildLogTail = z.infer<typeof BuildLogTailSchema>;
