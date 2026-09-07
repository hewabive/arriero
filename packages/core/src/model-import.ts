import { z } from "zod";

export const ModelImportRequestSchema = z.object({
  sourcePath: z.string().min(1),
  scope: z.enum(["gguf", "directory"]),
  repo: z.string().min(1),
  revision: z.string().default("main"),
  remotePath: z.string().default(""),
});
export const ModelImportCommitSchema = z.object({ id: z.string().min(1) });
export const ModelImportFileSchema = z.object({
  source: z.string(),
  destination: z.string(),
  size: z.number(),
  verified: z.boolean(),
});
export const ModelImportStateSchema = z.object({
  id: z.string(),
  status: z.enum(["checking", "ready", "importing", "succeeded", "failed"]),
  sourcePath: z.string(),
  destDir: z.string(),
  repoId: z.string(),
  revision: z.string(),
  files: z.array(ModelImportFileSchema),
  completed: z.number(),
  total: z.number(),
  currentFile: z.string().nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type ModelImportRequest = z.infer<typeof ModelImportRequestSchema>;
export type ModelImportState = z.infer<typeof ModelImportStateSchema>;
