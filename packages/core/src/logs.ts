import { z } from "zod";

export const LOG_FILE_CATEGORIES = [
  "instance",
  "webapp",
  "build",
  "env",
  "update",
  "other",
] as const;

export const LogFileCategorySchema = z.enum(LOG_FILE_CATEGORIES);

export type LogFileCategory = z.infer<typeof LogFileCategorySchema>;

export const LogRetentionSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(30),
  maxTotalMb: z.number().int().min(16).max(1_048_576).nullable().default(null),
});

export type LogRetentionSettings = z.infer<typeof LogRetentionSettingsSchema>;

export const LogUsageCategorySchema = z.object({
  category: LogFileCategorySchema,
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

export const LogStorageUsageSchema = z.object({
  totalFiles: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  oldestFileAt: z.string().nullable(),
  categories: z.array(LogUsageCategorySchema),
  proxyRequests: z.object({
    requestDirs: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
});

export type LogStorageUsage = z.infer<typeof LogStorageUsageSchema>;

export const LogPruneResultSchema = z.object({
  deletedFiles: z.number().int().min(0),
  freedBytes: z.number().int().min(0),
  prunedTraces: z.number().int().min(0),
  prunedRequestDirs: z.number().int().min(0),
});

export type LogPruneResult = z.infer<typeof LogPruneResultSchema>;
