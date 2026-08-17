import { z } from "zod";

export const ConfigGitFileStatusSchema = z.object({
  path: z.string(),
  origPath: z.string().nullable().default(null),
  index: z.string().length(1),
  worktree: z.string().length(1),
});

export const ConfigGitBranchSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
});

export const ConfigGitStatusSchema = z.object({
  configDir: z.string(),
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  originUrl: z.string().nullable(),
  originRedacted: z.boolean().default(false),
  branch: z.string().nullable(),
  detached: z.boolean(),
  head: z.string().nullable(),
  shortHead: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  dirty: z.boolean(),
  hasCommits: z.boolean().default(false),
  hasUnpushedCommits: z.boolean().default(false),
  files: z.array(ConfigGitFileStatusSchema),
  branches: z.array(ConfigGitBranchSchema),
  remoteBranches: z.array(z.string()),
  backups: z.array(z.string()).default([]),
  authorName: z.string().nullable(),
  authorEmail: z.string().nullable(),
  activeOperation: z.string().nullable(),
  error: z.string().nullable(),
});

export const ConfigGitDirtySummarySchema = z.object({
  isGitRepo: z.boolean(),
  dirty: z.boolean(),
  fileCount: z.number().int().nonnegative(),
});

export const ConfigGitDiffSchema = z.object({
  staged: z.string(),
  unstaged: z.string(),
  truncated: z.boolean(),
});

export const ConfigGitCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  subject: z.string(),
  body: z.string(),
});

export const ConfigGitValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const ConfigGitValidationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(ConfigGitValidationIssueSchema),
});

export const ConfigGitMutationResultSchema = z.object({
  operation: z.string(),
  output: z.string(),
  backupPath: z.string().nullable().default(null),
  status: ConfigGitStatusSchema,
  validation: ConfigGitValidationSchema,
});

export const ConfigGitCloneSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048),
  branch: z.string().trim().min(1).max(255).nullable().default(null),
  replaceExisting: z.boolean().default(false),
  discardUnpushed: z.boolean().default(false),
});

export const ConfigGitInitSchema = z.object({
  branch: z.string().trim().min(1).max(255).default("main"),
  message: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .default("Initial configuration"),
  authorName: z.string().trim().min(1).max(200).nullable().default(null),
  authorEmail: z.string().trim().email().max(320).nullable().default(null),
});

export const ConfigGitRemoteSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048).nullable(),
  fetch: z.boolean().default(true),
});

export const ConfigGitSwitchSchema = z.object({
  branch: z.string().trim().min(1).max(255),
});

export const ConfigGitCreateBranchSchema = z.object({
  branch: z.string().trim().min(1).max(255),
  startPoint: z.string().trim().min(1).max(255).nullable().default(null),
});

export const ConfigGitCheckoutCommitSchema = z.object({
  commit: z.string().trim().min(4).max(255),
});

export const ConfigGitResetSchema = z.object({
  includeUntracked: z.boolean().default(false),
  confirm: z.literal(true),
});

export const ConfigGitCommitInputSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  authorName: z.string().trim().min(1).max(200).nullable().default(null),
  authorEmail: z.string().trim().email().max(320).nullable().default(null),
});

export const CONFIG_GIT_PROXY_COLLECTIONS = [
  "targets",
  "models",
  "pipelines",
  "endpoints",
  "sources",
  "settings",
] as const;

export type ConfigGitProxyCollection =
  (typeof CONFIG_GIT_PROXY_COLLECTIONS)[number];

export type ConfigGitPortableFileKind =
  | "settings"
  | "argument-defaults"
  | "resources"
  | "nodes"
  | "instance"
  | "preset"
  | `proxy-${ConfigGitProxyCollection}`;

const configGitInstancePathPattern = /^instances\/[A-Za-z0-9._-]+\.json$/;
const configGitPresetPathPattern = /^presets\/[A-Za-z0-9._-]+\.ini$/;
const configGitProxyPathPattern = new RegExp(
  `^proxy/(${CONFIG_GIT_PROXY_COLLECTIONS.join("|")})\\.json$`,
);

export function classifyConfigGitPath(
  path: string,
): ConfigGitPortableFileKind | null {
  switch (path) {
    case "settings.json":
      return "settings";
    case "argument-defaults.json":
      return "argument-defaults";
    case "resources.json":
      return "resources";
    case "nodes.json":
      return "nodes";
    default:
      break;
  }
  if (configGitInstancePathPattern.test(path)) {
    return "instance";
  }
  if (configGitPresetPathPattern.test(path)) {
    return "preset";
  }
  const proxy = configGitProxyPathPattern.exec(path);
  if (proxy) {
    return `proxy-${proxy[1]}` as ConfigGitPortableFileKind;
  }
  return null;
}

export function configGitInstanceName(path: string): string | null {
  if (classifyConfigGitPath(path) !== "instance") {
    return null;
  }
  return path.slice("instances/".length, -".json".length);
}

export function isPlainRelativeConfigGitPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.endsWith("/") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export const configGitSensitivePathPattern =
  /(^|\/)(\.secrets\.json|\.env(?:\..*)?|.*\.(?:pem|key))$/i;

export function isRestorableConfigGitPath(path: string): boolean {
  return (
    classifyConfigGitPath(path) !== null &&
    !configGitSensitivePathPattern.test(path)
  );
}

const ConfigGitRestorePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isPlainRelativeConfigGitPath, {
    message: "path must be a plain relative file path",
  });

export const ConfigGitRestoreFilesSchema = z.object({
  ref: z.string().trim().min(1).max(255),
  paths: z.array(ConfigGitRestorePathSchema).min(1).max(50),
});

export const ConfigGitCommitFileChangeSchema = z.object({
  path: z.string(),
  status: z.string().min(1).max(1),
});

export const ConfigGitCommitDetailSchema = ConfigGitCommitSchema.extend({
  files: z.array(ConfigGitCommitFileChangeSchema),
  tree: z.array(z.string()),
});

export type ConfigGitFileStatus = z.infer<typeof ConfigGitFileStatusSchema>;
export type ConfigGitBranch = z.infer<typeof ConfigGitBranchSchema>;
export type ConfigGitStatus = z.infer<typeof ConfigGitStatusSchema>;
export type ConfigGitDirtySummary = z.infer<typeof ConfigGitDirtySummarySchema>;
export type ConfigGitDiff = z.infer<typeof ConfigGitDiffSchema>;
export type ConfigGitCommit = z.infer<typeof ConfigGitCommitSchema>;
export type ConfigGitValidationIssue = z.infer<
  typeof ConfigGitValidationIssueSchema
>;
export type ConfigGitValidation = z.infer<typeof ConfigGitValidationSchema>;
export type ConfigGitMutationResult = z.infer<
  typeof ConfigGitMutationResultSchema
>;
export type ConfigGitClone = z.infer<typeof ConfigGitCloneSchema>;
export type ConfigGitInit = z.infer<typeof ConfigGitInitSchema>;
export type ConfigGitRemote = z.infer<typeof ConfigGitRemoteSchema>;
export type ConfigGitSwitch = z.infer<typeof ConfigGitSwitchSchema>;
export type ConfigGitCreateBranch = z.infer<typeof ConfigGitCreateBranchSchema>;
export type ConfigGitCheckoutCommit = z.infer<
  typeof ConfigGitCheckoutCommitSchema
>;
export type ConfigGitReset = z.infer<typeof ConfigGitResetSchema>;
export type ConfigGitCommitInput = z.infer<typeof ConfigGitCommitInputSchema>;
export type ConfigGitRestoreFiles = z.infer<typeof ConfigGitRestoreFilesSchema>;
export type ConfigGitCommitFileChange = z.infer<
  typeof ConfigGitCommitFileChangeSchema
>;
export type ConfigGitCommitDetail = z.infer<typeof ConfigGitCommitDetailSchema>;
