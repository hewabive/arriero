import { z } from "zod";

import { InstanceSchema } from "./instance.js";

export const ProcessEventSchema = z.object({
  type: z.enum(["log", "status", "exit", "error"]),
  instanceId: z.string(),
  timestamp: z.string(),
  message: z.string(),
});

export const ProcessStopReasonSchema = z.enum([
  "operator",
  "eviction",
  "idle",
  "shutdown",
  "delete",
  "stale",
  "crash",
]);

export const RuntimeStateSchema = z.object({
  instanceId: z.string(),
  pid: z.number().int().positive().nullable(),
  status: InstanceSchema.shape.status,
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  logPath: z.string().nullable(),
  rawLogPath: z.string().nullable(),
  adopted: z.boolean().optional(),
  stopReason: ProcessStopReasonSchema.nullable().optional(),
});

export const ProcessPreflightIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  field: z.string(),
  message: z.string(),
});

export const ProcessPreflightResultSchema = z.object({
  instanceId: z.string(),
  ok: z.boolean(),
  issues: z.array(ProcessPreflightIssueSchema),
  checkedAt: z.string(),
});

export const LogTailSchema = z.object({
  instanceId: z.string(),
  logPath: z.string().nullable(),
  rawLogPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export const ExternalLlamaProcessSchema = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative().nullable(),
  command: z.string(),
  args: z.string(),
  managedInstanceId: z.string().nullable(),
  managedRunStatus: z.string().nullable(),
});

export const ExternalLlamaProcessesResultSchema = z.object({
  processes: z.array(ExternalLlamaProcessSchema),
  scannedAt: z.string(),
  unsupported: z.boolean(),
  error: z.string().nullable(),
});

export const ExternalProcessKillSchema = z.object({
  force: z.boolean().default(false),
});

export const ExternalProcessKillResultSchema = z.object({
  pid: z.number().int().positive(),
  signal: z.enum(["SIGTERM", "SIGKILL"]),
  killed: z.boolean(),
});

export type ProcessEvent = z.infer<typeof ProcessEventSchema>;
export type ProcessStopReason = z.infer<typeof ProcessStopReasonSchema>;
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type ProcessPreflightIssue = z.infer<typeof ProcessPreflightIssueSchema>;
export type ProcessPreflightResult = z.infer<
  typeof ProcessPreflightResultSchema
>;
export type LogTail = z.infer<typeof LogTailSchema>;
export type ExternalLlamaProcess = z.infer<typeof ExternalLlamaProcessSchema>;
export type ExternalLlamaProcessesResult = z.infer<
  typeof ExternalLlamaProcessesResultSchema
>;
export type ExternalProcessKill = z.infer<typeof ExternalProcessKillSchema>;
export type ExternalProcessKillResult = z.infer<
  typeof ExternalProcessKillResultSchema
>;
