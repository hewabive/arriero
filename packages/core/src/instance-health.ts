import { z } from "zod";

import { LlamaProbeSchema } from "./llama.js";
import { MemoryAssessmentSummarySchema } from "./memory-assessment.js";
import {
  ProcessPreflightIssueSchema,
  ProcessPreflightResultSchema,
  RuntimeStateSchema,
} from "./process.js";

export const InstanceLoadProgressStageSchema = z.enum([
  "pending",
  "starting",
  "metadata",
  "tensors",
  "context",
  "warmup",
  "ready",
  "error",
]);

export const InstanceLoadProgressSchema = z.object({
  stage: InstanceLoadProgressStageSchema,
  percent: z.number().int().min(0).max(100).nullable(),
  message: z.string(),
  estimated: z.boolean(),
});

export const InstanceMemoryPlacementKindSchema = z.enum([
  "device",
  "host",
  "other",
]);

export const InstanceMemoryLayoutSourceSchema = z.enum([
  "none",
  "log-buffers",
  "log-projection",
  "process-telemetry",
]);

export const InstanceMemoryPlacementSchema = z.object({
  label: z.string(),
  kind: InstanceMemoryPlacementKindSchema,
  modelBytes: z.number().int().nonnegative(),
  contextBytes: z.number().int().nonnegative(),
  computeBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  adapterBytes: z.number().int().nonnegative(),
  otherBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export const InstanceMemoryLayoutSchema = z.object({
  source: InstanceMemoryLayoutSourceSchema,
  sourceDetail: z.string().nullable(),
  processIds: z.array(z.number().int().positive()),
  entries: z.array(InstanceMemoryPlacementSchema),
  deviceBytes: z.number().int().nonnegative(),
  hostBytes: z.number().int().nonnegative(),
  otherBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  projectedHostBytes: z.number().int().nonnegative().nullable(),
  projectedHostTotalBytes: z.number().int().nonnegative().nullable(),
});

export const InstanceLogSummarySchema = z.object({
  instanceId: z.string(),
  logPath: z.string().nullable(),
  listeningUrl: z.string().nullable(),
  modelPath: z.string().nullable(),
  modelAlias: z.string().nullable(),
  contextSize: z.number().int().positive().nullable(),
  gpuLayers: z.string().nullable(),
  slots: z.number().int().positive().nullable(),
  ready: z.boolean(),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  notices: z.array(z.string()),
  loadProgress: InstanceLoadProgressSchema,
  memoryLayout: InstanceMemoryLayoutSchema,
  updatedAt: z.string(),
});

export const InstanceHealthSummaryStatusSchema = z.enum([
  "stopped",
  "invalid",
  "starting",
  "stopping",
  "loading",
  "ready",
  "degraded",
  "stale",
  "error",
]);

export const InstanceHealthActionsSchema = z.object({
  canStart: z.boolean(),
  canStop: z.boolean(),
  canRestart: z.boolean(),
});

export const PromptCacheStateSchema = z.object({
  prompts: z.number().int().min(0),
  sizeMiB: z.number().min(0),
  limitMiB: z.number().min(0).nullable(),
  at: z.string(),
});

export const NumaPlacementSchema = z.object({
  perNode: z.array(
    z.object({
      node: z.number().int().min(0),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  totalBytes: z.number().int().nonnegative(),
  maxNodeSharePct: z.number().int().min(0).max(100),
  idealSharePct: z.number().int().min(0).max(100),
  even: z.boolean(),
  interleaveNodeCount: z.number().int().min(1),
});

export const InstanceHealthSummarySchema = z.object({
  instanceId: z.string(),
  status: InstanceHealthSummaryStatusSchema,
  reason: z.string(),
  actions: InstanceHealthActionsSchema,
  runtime: RuntimeStateSchema,
  preflight: ProcessPreflightResultSchema,
  llama: LlamaProbeSchema,
  logSummary: InstanceLogSummarySchema,
  promptCache: PromptCacheStateSchema.nullable().default(null),
  configDrift: z.boolean().default(false),
  memoryAssessment: MemoryAssessmentSummarySchema.optional(),
  swapBytes: z.number().int().min(0).nullable().default(null),
  numaPlacement: NumaPlacementSchema.nullable().default(null),
  checkedAt: z.string(),
});

export const InstanceBulkActionNameSchema = z.enum([
  "start",
  "stop",
  "restart",
]);

export const InstanceBulkActionRequestSchema = z.object({
  action: InstanceBulkActionNameSchema,
  instanceIds: z.array(z.string().min(1)).optional(),
});

export const InstanceBulkActionItemSchema = z.object({
  instanceId: z.string(),
  name: z.string(),
  action: InstanceBulkActionNameSchema,
  ok: z.boolean(),
  skipped: z.boolean(),
  status: RuntimeStateSchema.nullable(),
  error: z.string().nullable(),
  issues: z.array(ProcessPreflightIssueSchema).default([]),
});

export const InstanceBulkActionResultSchema = z.object({
  action: InstanceBulkActionNameSchema,
  requested: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  items: z.array(InstanceBulkActionItemSchema),
});

export type InstanceLoadProgressStage = z.infer<
  typeof InstanceLoadProgressStageSchema
>;
export type InstanceLoadProgress = z.infer<typeof InstanceLoadProgressSchema>;
export type InstanceMemoryPlacement = z.infer<
  typeof InstanceMemoryPlacementSchema
>;
export type InstanceMemoryLayoutSource = z.infer<
  typeof InstanceMemoryLayoutSourceSchema
>;
export type InstanceMemoryLayout = z.infer<typeof InstanceMemoryLayoutSchema>;
export type InstanceLogSummary = z.infer<typeof InstanceLogSummarySchema>;
export type InstanceHealthSummaryStatus = z.infer<
  typeof InstanceHealthSummaryStatusSchema
>;
export type InstanceHealthActions = z.infer<typeof InstanceHealthActionsSchema>;
export type InstanceHealthSummary = z.infer<typeof InstanceHealthSummarySchema>;
export type NumaPlacement = z.infer<typeof NumaPlacementSchema>;
export type PromptCacheState = z.infer<typeof PromptCacheStateSchema>;
export type InstanceBulkActionName = z.infer<
  typeof InstanceBulkActionNameSchema
>;
export type InstanceBulkActionRequest = z.infer<
  typeof InstanceBulkActionRequestSchema
>;
export type InstanceBulkActionItem = z.infer<
  typeof InstanceBulkActionItemSchema
>;
export type InstanceBulkActionResult = z.infer<
  typeof InstanceBulkActionResultSchema
>;
