import { z } from "zod";

import { HfRepoIdSchema } from "./hf.js";

export const ModelLibraryFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  oid: z.string().min(1),
  lfsOid: z.string().nullable(),
});
export const ModelLibrarySnapshotSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/i),
  files: z.array(ModelLibraryFileSchema).max(10000),
});
export type ModelLibraryFile = z.infer<typeof ModelLibraryFileSchema>;
export type ModelLibrarySnapshot = z.infer<typeof ModelLibrarySnapshotSchema>;
export const ModelLibraryCheckSchema = z.object({
  status: z.enum(["unchecked", "current", "changed", "error"]),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
  snapshot: ModelLibrarySnapshotSchema.nullable(),
  changes: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["added", "updated", "deleted"]),
    }),
  ),
});
export type ModelLibraryCheck = z.infer<typeof ModelLibraryCheckSchema>;
export const ModelLibraryEntrySchema = z
  .object({
    id: z.string().min(1),
    repoId: HfRepoIdSchema,
    revision: z.string().min(1),
    paths: z.array(z.string().min(1)).max(2_000).default([]),
    destDir: z.string().min(1).nullable().default(null),
    watchRevision: z.string().min(1).default("main"),
    snapshot: ModelLibrarySnapshotSchema.nullable().default(null),
    pinnedFiles: z.array(ModelLibraryFileSchema).default([]),
  })
  .catchall(z.unknown());

export const ModelLibraryEntryCreateSchema = z.object({
  repoId: HfRepoIdSchema,
  revision: z.string().min(1).default("main"),
  paths: z.array(z.string().min(1)).max(2_000).default([]),
  destDir: z.string().min(1).nullable().default(null),
});

export const ModelLibraryEntryStateSchema = z.enum([
  "watching",
  "satisfied",
  "partial",
  "missing",
]);

export const ModelLibraryEntryStatusSchema = z.object({
  entry: ModelLibraryEntrySchema,
  state: ModelLibraryEntryStateSchema,
  matchedDir: z.string().nullable(),
  missingPaths: z.array(z.string()),
  revisionMatch: z.boolean().nullable(),
  driftPaths: z.array(z.string()),
  check: ModelLibraryCheckSchema,
});

export function isHfCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export type ModelLibraryEntry = z.infer<typeof ModelLibraryEntrySchema>;
export type ModelLibraryEntryCreate = z.infer<
  typeof ModelLibraryEntryCreateSchema
>;
export type ModelLibraryEntryState = z.infer<
  typeof ModelLibraryEntryStateSchema
>;
export type ModelLibraryEntryStatus = z.infer<
  typeof ModelLibraryEntryStatusSchema
>;

export const ModelLibraryActionSchema = z.object({
  action: z.enum(["check", "acknowledge", "select", "pin", "download"]),
  revision: z.string().optional(),
  paths: z.array(z.string().min(1)).max(2000).optional(),
});
export type ModelLibraryAction = z.infer<typeof ModelLibraryActionSchema>;
