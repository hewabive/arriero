import { z } from "zod";

import { ConfigGitValidationIssueSchema } from "./config-git.js";

export const ConfigStoreCacheModeSchema = z.enum(["process", "per-read"]);
export type ConfigStoreCacheMode = z.infer<typeof ConfigStoreCacheModeSchema>;

export const ConfigStoreFileStateSchema = z.object({
  storeId: z.string(),
  path: z.string(),
  cacheMode: ConfigStoreCacheModeSchema,
  exists: z.boolean(),
  diskMtimeMs: z.number().nullable(),
  loadedMtimeMs: z.number().nullable(),
  dirtyOnDisk: z.boolean().nullable(),
});
export type ConfigStoreFileState = z.infer<typeof ConfigStoreFileStateSchema>;

export const ConfigStateSchema = z.object({
  files: z.array(ConfigStoreFileStateSchema),
  dirtyOnDisk: z.boolean(),
});
export type ConfigState = z.infer<typeof ConfigStateSchema>;

export const ConfigReloadResultSchema = z.object({
  applied: z.boolean(),
  issues: z.array(ConfigGitValidationIssueSchema),
  normalizedFiles: z.array(z.string()),
});
export type ConfigReloadResult = z.infer<typeof ConfigReloadResultSchema>;
