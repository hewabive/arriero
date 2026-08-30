import { z } from "zod";

const HF_REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

export const HfRepoIdSchema = z.string().regex(HF_REPO_ID_PATTERN);

export function isHfRepoId(value: string): boolean {
  return HF_REPO_ID_PATTERN.test(value);
}

export const HfLfsInfoSchema = z.object({
  oid: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const HfTreeFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  oid: z.string().min(1),
  lfs: HfLfsInfoSchema.nullable(),
});

export const HfGgufVariantKindSchema = z.enum(["model", "mmproj", "other"]);

export const HfGgufVariantSchema = z.object({
  label: z.string().nullable(),
  kind: HfGgufVariantKindSchema,
  paths: z.array(z.string().min(1)).min(1),
  totalBytes: z.number().int().nonnegative(),
  splitCount: z.number().int().nullable(),
  complete: z.boolean(),
});

export const HfRepoBrowseSchema = z.object({
  repoId: HfRepoIdSchema,
  requestedRevision: z.string().min(1),
  commitSha: z.string().min(1),
  gated: z.boolean(),
  private: z.boolean(),
  files: z.array(HfTreeFileSchema),
  ggufVariants: z.array(HfGgufVariantSchema).nullable(),
  truncated: z.boolean(),
});

export const HfTokenStatusSchema = z.object({
  tokenConfigured: z.boolean(),
});

export const HfTokenUpdateSchema = z.object({
  token: z.string().min(1).max(4_000).nullable(),
});

export const HfDownloadStartSchema = z.object({
  repoId: HfRepoIdSchema,
  revision: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).max(2_000),
  destDir: z.string().min(1).optional(),
});

export const HfDownloadFileStatusSchema = z.enum([
  "pending",
  "downloading",
  "succeeded",
  "skipped",
  "failed",
  "canceled",
]);

export const HfDownloadFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  status: HfDownloadFileStatusSchema,
  downloadedBytes: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const HfDownloadJobStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "canceled",
]);

export const HfDownloadPauseReasonSchema = z.enum([
  "network",
  "manual",
  "slow-eta",
]);

export const HfDownloadResumeSchema = z.object({
  ignoreSlowEta: z.boolean().optional(),
});

export const HfDownloadTransferSchema = z.object({
  payloadBps: z.number().nonnegative().nullable(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  wireBytes: z.number().int().nonnegative(),
  wastedBytes: z.number().int().nonnegative(),
  resetCount: z.number().int().nonnegative(),
  lastProgressAt: z.string().nullable(),
  stalledSeconds: z.number().int().nonnegative().nullable(),
});

export const HfDownloadQueueJobSchema = z.object({
  id: z.string().min(1),
  repoId: HfRepoIdSchema,
  revision: z.string().min(1),
  destDir: z.string().min(1),
  status: HfDownloadJobStatusSchema,
  message: z.string().nullable(),
  error: z.string().nullable(),
  enqueuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  pauseRequested: z.boolean().default(false),
  pauseReason: HfDownloadPauseReasonSchema.nullable().default(null),
  slowEtaOverride: z.boolean().default(false),
  totalBytes: z.number().int().nonnegative(),
  downloadedBytes: z.number().int().nonnegative(),
  connections: z.number().int().positive().nullable(),
  transfer: HfDownloadTransferSchema.nullable().default(null),
  files: z.array(HfDownloadFileSchema),
});

export const HfDownloadQueueStateSchema = z.object({
  active: HfDownloadQueueJobSchema.nullable(),
  queued: z.array(HfDownloadQueueJobSchema),
  paused: z.array(HfDownloadQueueJobSchema),
  history: z.array(HfDownloadQueueJobSchema),
});

export const HfDownloadQueueReorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const HfDownloadFileSkipSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(2_000),
});

export const HfOrphanPartSchema = z.object({
  path: z.string().min(1),
  partialBytes: z.number().int().nonnegative(),
});

export const HfDownloadSettingsSchema = z.object({
  modelDirectoryId: z.string().min(1).nullable().default(null),
  connections: z.number().int().min(1).max(16).default(6),
  chunkBytes: z
    .number()
    .int()
    .min(4 * 1024 * 1024)
    .max(512 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  maxEtaHours: z.number().int().min(1).max(720).nullable().default(24),
});

export const HfUpdateFileStatusSchema = z.enum([
  "current",
  "updated",
  "deleted",
]);

export const HfUpdateCheckStatusSchema = z.enum([
  "unchecked",
  "in-sync",
  "drift",
  "error",
]);

export const HfUpdateCheckFileSchema = z.object({
  path: z.string().min(1),
  status: HfUpdateFileStatusSchema,
});

export const HfUpdateCheckSchema = z.object({
  status: HfUpdateCheckStatusSchema,
  checkedAt: z.string().nullable(),
  revisionSha: z.string().nullable(),
  error: z.string().nullable(),
  files: z.array(HfUpdateCheckFileSchema),
});

export const HfDownloadedRepoFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  oid: z.string().min(1),
  lfsOid: z.string().nullable(),
  present: z.boolean(),
  partialBytes: z.number().int().nonnegative(),
});

export const HfDownloadedRepoSchema = z.object({
  dir: z.string().min(1),
  repoId: HfRepoIdSchema,
  revision: z.string().min(1),
  downloadedAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  missingFiles: z.number().int().nonnegative(),
  files: z.array(HfDownloadedRepoFileSchema),
  orphanParts: z.array(HfOrphanPartSchema),
  variants: z.array(HfGgufVariantSchema).nullable(),
  update: HfUpdateCheckSchema,
});

export function hfManifestOidMatches(
  entry: { oid: string; lfsOid: string | null },
  remote: { oid: string; lfs: { oid: string } | null },
): boolean {
  return entry.lfsOid !== null && remote.lfs !== null
    ? entry.lfsOid === remote.lfs.oid
    : entry.oid === remote.oid;
}

export const HF_UPDATE_CHECK_MAX_DIRS = 50;

export const HfUpdateCheckRequestSchema = z.object({
  dirs: z.array(z.string().min(1)).min(1).max(HF_UPDATE_CHECK_MAX_DIRS),
});

export const HfDownloadDeleteSchema = z.object({
  dir: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(2_000).optional(),
  verifyUpstream: z.boolean().optional(),
  removeRequirement: z.boolean().optional(),
});

export const HfDownloadDeleteBlockedSchema = z.object({
  error: z.string(),
  verification: HfUpdateCheckSchema,
});

export const HfDestCheckSchema = z.object({
  dir: z.string().min(1),
  insideScanRoots: z.boolean(),
  freeBytes: z.number().int().nonnegative().nullable(),
});

export function encodeHfPathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const HF_HOST_PATTERN = /^(?:www\.)?(?:huggingface\.co|hf\.co)\//i;

export function parseHfRepoInput(
  input: string,
): { repoId: string; revision: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const hostMatch = HF_HOST_PATTERN.test(withoutProtocol);
  if (hasProtocol && !hostMatch) {
    return null;
  }
  const path = hostMatch
    ? withoutProtocol.replace(HF_HOST_PATTERN, "")
    : withoutProtocol;
  const cleaned = path.split(/[?#]/, 1)[0] ?? "";
  const segments = cleaned.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    return null;
  }
  if (owner === "datasets" || owner === "spaces") {
    return null;
  }
  const repoId = `${owner}/${repo}`;
  if (!HF_REPO_ID_PATTERN.test(repoId)) {
    return null;
  }
  const marker = segments[2];
  const revisionSegment =
    marker === "tree" || marker === "blob" || marker === "resolve"
      ? segments[3]
      : undefined;
  let revision: string | null = null;
  if (revisionSegment) {
    try {
      revision = decodeURIComponent(revisionSegment);
    } catch {
      revision = revisionSegment;
    }
  }
  return { repoId, revision };
}

export type HfLfsInfo = z.infer<typeof HfLfsInfoSchema>;
export type HfTreeFile = z.infer<typeof HfTreeFileSchema>;
export type HfGgufVariantKind = z.infer<typeof HfGgufVariantKindSchema>;
export type HfGgufVariant = z.infer<typeof HfGgufVariantSchema>;
export type HfRepoBrowse = z.infer<typeof HfRepoBrowseSchema>;
export type HfTokenStatus = z.infer<typeof HfTokenStatusSchema>;
export type HfTokenUpdate = z.infer<typeof HfTokenUpdateSchema>;
export type HfDownloadStart = z.infer<typeof HfDownloadStartSchema>;
export type HfDownloadFileStatus = z.infer<typeof HfDownloadFileStatusSchema>;
export type HfDownloadFile = z.infer<typeof HfDownloadFileSchema>;
export type HfDownloadJobStatus = z.infer<typeof HfDownloadJobStatusSchema>;
export type HfDownloadPauseReason = z.infer<typeof HfDownloadPauseReasonSchema>;
export type HfDownloadResume = z.infer<typeof HfDownloadResumeSchema>;
export type HfDownloadTransfer = z.infer<typeof HfDownloadTransferSchema>;
export type HfDownloadQueueJob = z.infer<typeof HfDownloadQueueJobSchema>;
export type HfDownloadQueueState = z.infer<typeof HfDownloadQueueStateSchema>;
export type HfDownloadQueueReorder = z.infer<
  typeof HfDownloadQueueReorderSchema
>;
export type HfDownloadFileSkip = z.infer<typeof HfDownloadFileSkipSchema>;
export type HfOrphanPart = z.infer<typeof HfOrphanPartSchema>;
export type HfDownloadSettings = z.infer<typeof HfDownloadSettingsSchema>;
export type HfUpdateFileStatus = z.infer<typeof HfUpdateFileStatusSchema>;
export type HfUpdateCheckStatus = z.infer<typeof HfUpdateCheckStatusSchema>;
export type HfUpdateCheckFile = z.infer<typeof HfUpdateCheckFileSchema>;
export type HfUpdateCheck = z.infer<typeof HfUpdateCheckSchema>;
export type HfDownloadedRepoFile = z.infer<typeof HfDownloadedRepoFileSchema>;
export type HfDownloadedRepo = z.infer<typeof HfDownloadedRepoSchema>;
export type HfUpdateCheckRequest = z.infer<typeof HfUpdateCheckRequestSchema>;
export type HfDownloadDelete = z.infer<typeof HfDownloadDeleteSchema>;
export type HfDownloadDeleteBlocked = z.infer<
  typeof HfDownloadDeleteBlockedSchema
>;
export type HfDestCheck = z.infer<typeof HfDestCheckSchema>;
