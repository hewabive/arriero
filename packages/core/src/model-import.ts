import { z } from "zod";

export const ModelImportRequestSchema = z.object({
  sourcePath: z.string().min(1),
  searchHf: z.boolean().optional(),
  scope: z.enum(["gguf", "directory"]),
  repo: z.string().default(""),
  revision: z.string().default("main"),
  remotePath: z.string().default(""),
});
export const ModelImportCommitSchema = z.object({ id: z.string().min(1) });
export const ModelImportFileSchema = z.object({
  source: z.string(),
  destination: z.string(),
  size: z.number(),
  verified: z.boolean(),
  alternatives: z.array(z.string()).optional(),
  keepSource: z.boolean().optional(),
});
export const ModelImportRelatedFileSchema = ModelImportFileSchema.extend({
  kind: z.enum(["companion", "variant"]),
  relativePath: z.string(),
});
export const ModelImportCandidateSchema = z.object({
  origin: z.enum(["library", "huggingface"]).optional(),
  id: z.string(),
  repoId: z.string(),
  revision: z.string(),
  files: z.array(ModelImportFileSchema),
  relatedFiles: z.array(ModelImportRelatedFileSchema),
});
export const ModelImportSelectionSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  companions: z.array(z.string()).max(200).default([]),
  destinations: z.record(z.string(), z.string()).default({}),
  keepCompanions: z.boolean().default(true),
});
export type ModelImportSelection = z.infer<typeof ModelImportSelectionSchema>;
export type ModelImportCandidate = z.infer<typeof ModelImportCandidateSchema>;
export type ModelImportRelatedFile = z.infer<
  typeof ModelImportRelatedFileSchema
>;
export const ModelImportStateSchema = z.object({
  scope: z.enum(["gguf", "directory"]),
  id: z.string(),
  status: z.enum([
    "searching",
    "checking",
    "choosing",
    "ready",
    "importing",
    "succeeded",
    "failed",
    "canceled",
  ]),
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
  candidates: z.array(ModelImportCandidateSchema),
  selectedCandidateId: z.string().nullable(),
  searchedRepositories: z.number(),
  searchTruncated: z.boolean(),
  blockers: z.array(z.string()),
});
export type ModelImportRequest = z.infer<typeof ModelImportRequestSchema>;
export type ModelImportState = z.infer<typeof ModelImportStateSchema>;
