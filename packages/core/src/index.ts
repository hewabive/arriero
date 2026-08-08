import { z } from "zod";

import { LlamaSourceSettingsSchema, LlamaSourceStatusSchema } from "./llama.js";
import { ApiProxyPublicModelStatusSchema } from "./proxy/api-proxy.js";
import { MemoryPoolViewSchema, ResourceLedgerSchema } from "./resources.js";

export * from "./engine-descriptor.js";
export * from "./ggml.js";
export * from "./instance-resources.js";
export * from "./memory-assessment.js";
export * from "./memory-estimate.js";
export * from "./proxy/request-edits.js";
export * from "./proxy/pipeline-graph.js";
export * from "./proxy/text-replacement.js";
export * from "./proxy/token-scale.js";
export * from "./resources.js";
export * from "./llama.js";
export * from "./instance.js";
export * from "./path-catalog.js";
export * from "./process.js";
export * from "./api-endpoints.js";
export * from "./proxy/pipeline-nodes.js";
export * from "./proxy/api-proxy.js";
export * from "./instance-health.js";
export * from "./filesystem.js";

export const PresetNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const FleetNodeIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);
export const FleetNodeNameSchema = z.string().trim().min(1).max(80);
export const FleetNodeBaseUrlSchema = z.string().trim().url();

export const FleetNodeSchema = z.object({
  id: FleetNodeIdSchema,
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
});
export type FleetNode = z.infer<typeof FleetNodeSchema>;

export const FleetNodeCreateSchema = z.object({
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
  token: z.string().min(1).optional(),
});
export type FleetNodeCreate = z.infer<typeof FleetNodeCreateSchema>;

export const FleetNodeUpdateSchema = z.object({
  name: FleetNodeNameSchema.optional(),
  baseUrl: FleetNodeBaseUrlSchema.optional(),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
});
export type FleetNodeUpdate = z.infer<typeof FleetNodeUpdateSchema>;

export const FleetNodeViewSchema = FleetNodeSchema.extend({
  hasToken: z.boolean(),
});
export type FleetNodeView = z.infer<typeof FleetNodeViewSchema>;

export const FederationCapabilitiesSchema = z.object({
  protocolVersion: z.number().int().positive(),
  instanceKinds: z.array(z.string().min(1)),
  creatableInstanceKinds: z.array(z.string().min(1)),
  unknownInstanceKindsTolerated: z.boolean(),
});
export type FederationCapabilities = z.infer<
  typeof FederationCapabilitiesSchema
>;

export const BuildProfileSchema = z.enum(["server", "full"]);
export const CmakeBooleanModeSchema = z.enum(["default", "on", "off"]);

export const SourceRepositoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const LLAMA_CPP_SOURCE_ID = "llama-cpp";

export const BackgroundJobStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const SourceRepositoryLocationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("managed") }),
  z.object({
    type: z.literal("external"),
    path: z.string().trim().min(1),
  }),
]);

export const SourceRepositorySpecSchema = z.object({
  id: SourceRepositoryIdSchema,
  adapter: z.string().trim().min(1).max(80),
  originUrl: z.string().trim().min(1).max(2048),
  location: SourceRepositoryLocationSchema,
});

export const SourceRepositorySettingsUpdateSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048),
});

export const SourceRepositoryCloneSchema = z.object({
  originUrl: z.string().trim().min(1).max(2048).optional(),
  branch: z.string().trim().min(1).max(255).nullable().default(null),
});

export const SourceRepositoryStateSchema = z.enum([
  "missing",
  "busy",
  "ready",
  "dirty",
  "invalid",
  "error",
]);

export const SourceRepositoryStatusSchema = z.object({
  spec: SourceRepositorySpecSchema,
  displayName: z.string(),
  repoPath: z.string(),
  state: SourceRepositoryStateSchema,
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  valid: z.boolean(),
  currentCommit: z.string().nullable(),
  latestTag: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  originMatches: z.boolean().nullable(),
  dirty: z.boolean().nullable(),
  driftSupported: z.boolean(),
  activeOperation: z.string().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});

export const SourceRepositoryOperationResultSchema = z.object({
  operation: z.string(),
  output: z.string(),
  status: SourceRepositoryStatusSchema,
});

export const SourceRepositoryOperationKindSchema = z.enum(["clone", "pull"]);

export const SourceRepositoryOperationStatusSchema = BackgroundJobStatusSchema;

export const SourceRepositoryOperationPhaseSchema = z.enum([
  "starting",
  "receiving",
  "resolving",
  "checking-out",
  "validating",
  "publishing",
  "updating",
  "complete",
]);

export const SourceRepositoryOperationJobSchema = z.object({
  id: z.string().min(1),
  sourceId: SourceRepositoryIdSchema,
  operation: SourceRepositoryOperationKindSchema,
  status: SourceRepositoryOperationStatusSchema,
  phase: SourceRepositoryOperationPhaseSchema,
  progress: z.number().min(0).max(100).nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  logLines: z.array(z.string()),
});

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

const EnvironmentVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const PythonVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const EnvironmentExtraSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

function credentialFreeUrl(value: string) {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function credentialFreeUrlSchema(
  label: string,
  protocols: string[],
  protocolsLabel: string,
) {
  return z
    .string()
    .url()
    .refine((value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, `${label} must use ${protocolsLabel}`)
    .refine(credentialFreeUrl, `${label} must not contain credentials`);
}

const EnvironmentPackageIndexUrlSchema = credentialFreeUrlSchema(
  "package index URL",
  ["http:", "https:"],
  "HTTP or HTTPS",
);

const EnvironmentPythonMirrorUrlSchema = credentialFreeUrlSchema(
  "Python mirror URL",
  ["file:", "http:", "https:"],
  "file, HTTP, or HTTPS",
);

const EnvironmentWheelUrlSchema = credentialFreeUrlSchema(
  "wheel URL",
  ["file:", "http:", "https:"],
  "file, HTTP, or HTTPS",
);

export const EnvironmentRepositorySettingsSchema = z.object({
  packageIndexUrl: EnvironmentPackageIndexUrlSchema.nullable().default(null),
  pythonMirrorUrl: EnvironmentPythonMirrorUrlSchema.nullable().default(null),
});

export const VllmEnvironmentInstallSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pypi"),
    extras: z.array(EnvironmentExtraSchema).max(20).default([]),
  }),
  z.object({
    kind: z.literal("wheel"),
    url: EnvironmentWheelUrlSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .default(null),
    torchBackend: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9._-]+$/)
      .nullable()
      .default(null),
  }),
]);

export const KTransformersWheelArtifactSchema = z.object({
  distribution: z.enum(["kt-kernel", "sglang-kt"]),
  url: EnvironmentWheelUrlSchema,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable()
    .default(null),
});

const KTransformersWheelArtifactsSchema = z
  .array(KTransformersWheelArtifactSchema)
  .length(2)
  .superRefine((artifacts, ctx) => {
    for (const distribution of ["kt-kernel", "sglang-kt"] as const) {
      if (
        artifacts.filter((artifact) => artifact.distribution === distribution)
          .length !== 1
      ) {
        ctx.addIssue({
          code: "custom",
          message: `exactly one ${distribution} wheel is required`,
        });
      }
    }
  });

export const KTransformersEnvironmentInstallSourceSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("pypi"),
    }),
    z.object({
      kind: z.literal("wheels"),
      artifacts: KTransformersWheelArtifactsSchema,
      torchBackend: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[A-Za-z0-9._-]+$/)
        .nullable()
        .default(null),
    }),
  ],
);

export const EnvironmentInstallSourceSchema = z.union([
  VllmEnvironmentInstallSourceSchema,
  KTransformersEnvironmentInstallSourceSchema,
]);

export const EnvironmentEngineSchema = z.enum(["vllm", "ktransformers"]);

const EnvironmentCommonShape = {
  version: EnvironmentVersionSchema,
};

const VllmEnvironmentCreateObjectSchema = z.object({
  ...EnvironmentCommonShape,
  engine: z.literal("vllm"),
  variant: z.enum(["cuda", "cpu", "rocm"]).default("cuda"),
  pythonVersion: PythonVersionSchema.default("3.12"),
  source: VllmEnvironmentInstallSourceSchema.default({
    kind: "pypi",
    extras: [],
  }),
});

const KTransformersEnvironmentCreateObjectSchema = z.object({
  ...EnvironmentCommonShape,
  engine: z.literal("ktransformers"),
  variant: z.literal("cuda").default("cuda"),
  pythonVersion: z.enum(["3.11", "3.12"]).default("3.12"),
  source: KTransformersEnvironmentInstallSourceSchema.default({
    kind: "pypi",
  }),
});

function withLegacyVllmEngine(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("engine" in value)
  ) {
    return { ...value, engine: "vllm" };
  }
  return value;
}

const EnvironmentCreateUnionSchema = z.discriminatedUnion("engine", [
  VllmEnvironmentCreateObjectSchema,
  KTransformersEnvironmentCreateObjectSchema,
]);

export const EnvironmentCreateSchema = z.preprocess(
  withLegacyVllmEngine,
  EnvironmentCreateUnionSchema,
);

const EnvironmentSpecMetadataShape = {
  id: z.string().min(1),
  pathCatalogEntryId: z.string().min(1).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const EnvironmentSpecSchema = z.preprocess(
  withLegacyVllmEngine,
  z.discriminatedUnion("engine", [
    VllmEnvironmentCreateObjectSchema.extend(EnvironmentSpecMetadataShape),
    KTransformersEnvironmentCreateObjectSchema.extend(
      EnvironmentSpecMetadataShape,
    ),
  ]),
);

export function packageIndexInstallOptions(indexUrl: string | null) {
  return indexUrl ? ["--default-index", indexUrl] : [];
}

export const PackageIndexFileSchema = z.object({
  filename: z.string(),
  pythonTag: z.string().nullable(),
  platformTag: z.string().nullable(),
});

export const PackageIndexVersionSchema = z.object({
  version: z.string(),
  requiresPython: z.string().nullable(),
  pythonCompatible: z.boolean().nullable(),
  preRelease: z.boolean(),
  files: z.array(PackageIndexFileSchema),
  missingDistributions: z.array(z.string()),
});

export const PackageIndexLookupStatusSchema = z.enum([
  "ok",
  "empty",
  "auth-required",
  "not-found",
  "unreachable",
]);

export const EnvironmentIndexVersionsSchema = z.object({
  engine: EnvironmentEngineSchema,
  indexUrl: z.string(),
  distributions: z.array(z.string()),
  status: PackageIndexLookupStatusSchema,
  message: z.string().nullable(),
  versions: z.array(PackageIndexVersionSchema),
});

export const EnvironmentStatusSchema = z.enum([
  "missing",
  "installing",
  "installed",
  "failed",
]);

const EnvironmentRecordShape = {
  ...EnvironmentSpecMetadataShape,
  status: EnvironmentStatusSchema,
  availability: z.enum(["not-installed", "usable", "unavailable"]),
  availabilityReason: z.string().nullable(),
  path: z.string(),
  entrypoint: z.string(),
  error: z.string().nullable(),
};

export const EnvironmentRecordSchema = z.preprocess(
  withLegacyVllmEngine,
  z.discriminatedUnion("engine", [
    VllmEnvironmentCreateObjectSchema.extend(EnvironmentRecordShape),
    KTransformersEnvironmentCreateObjectSchema.extend(EnvironmentRecordShape),
  ]),
);

export const EnvironmentJobStatusSchema = BackgroundJobStatusSchema;
export const EnvironmentJobStepNameSchema = z.enum([
  "python-install",
  "venv-create",
  "artifact-verify",
  "package-install",
  "freeze",
  "finalize",
  "validate",
]);
export const EnvironmentJobStepSchema = z.object({
  name: EnvironmentJobStepNameSchema,
  command: z.array(z.string()),
  status: BuildJobStepStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
});
export const EnvironmentJobSchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  status: EnvironmentJobStatusSchema,
  steps: z.array(EnvironmentJobStepSchema),
  currentStep: EnvironmentJobStepNameSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logPath: z.string(),
  error: z.string().nullable(),
});
export const EnvironmentLogTailSchema = z.object({
  jobId: z.string(),
  logPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export const ENVIRONMENT_UV_MIN_VERSION = "0.11.16";

export const UvToolStatusSchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  reason: z.string().nullable(),
});

export const AppRunModeSchema = z.enum(["serve", "dev", "unknown"]);

export const AppVersionSchema = z.object({
  commit: z.string().nullable(),
  shortCommit: z.string().nullable(),
  committedAt: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  isGitRepo: z.boolean(),
  mode: AppRunModeSchema,
  supervised: z.boolean(),
  canUpdate: z.boolean(),
  updateBlockedReason: z.string().nullable(),
  behindCount: z.number().int().nullable(),
  upstreamCommit: z.string().nullable(),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string().nullable(),
});

export const UpdateJobStatusSchema = BackgroundJobStatusSchema;
export const UpdateJobStepNameSchema = z.enum([
  "snapshot",
  "git-pull",
  "install",
  "build",
  "restart",
]);
export const UpdateJobStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const UpdateJobStepSchema = z.object({
  name: UpdateJobStepNameSchema,
  status: UpdateJobStepStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
});

export const UpdateJobSchema = z.object({
  id: z.string(),
  status: UpdateJobStatusSchema,
  steps: z.array(UpdateJobStepSchema),
  currentStep: UpdateJobStepNameSchema.nullable(),
  fromCommit: z.string().nullable(),
  toCommit: z.string().nullable(),
  willRestart: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logPath: z.string(),
  error: z.string().nullable(),
});

export const UpdateJobStartSchema = z.object({
  restart: z.boolean().default(true),
});

export const UpdateLogTailSchema = z.object({
  jobId: z.string(),
  logPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export const UpdateUpstreamSchema = z.object({
  commit: z.string(),
  shortCommit: z.string(),
  committedAt: z.string().nullable(),
  ref: z.string().nullable(),
  lastCheckedAt: z.string(),
});

export const UpdateFleetNodeSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  self: z.boolean(),
  baseUrl: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  version: AppVersionSchema.nullable(),
  outdated: z.boolean(),
  behindCount: z.number().int().nullable(),
});

export const UpdateFleetSchema = z.object({
  upstream: UpdateUpstreamSchema.nullable(),
  nodes: z.array(UpdateFleetNodeSchema),
});

export const ConfigGitFileStatusSchema = z.object({
  path: z.string(),
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

export const ArgumentValueTypeSchema = z.enum([
  "flag",
  "boolean",
  "number",
  "string",
  "path",
  "json",
  "enum",
  "list",
]);

export const ArgumentControlKindSchema = z.enum([
  "flag",
  "toggle",
  "select",
  "number",
  "text",
  "path",
  "json",
  "csv-list",
  "secret",
  "two-values",
]);

export const ArgumentCliEncodingSchema = z.enum([
  "flag",
  "value",
  "csv",
  "repeated",
  "two-values",
]);

export const LlamaArgumentPresetSupportSchema = z.enum([
  "supported",
  "unsupported",
  "preset-only",
  "model-managed",
  "router-managed",
]);

export const ArgumentControlSchema = z
  .object({
    kind: ArgumentControlKindSchema,
    cliEncoding: ArgumentCliEncodingSchema,
    presetSupport: LlamaArgumentPresetSupportSchema,
  })
  .default({
    kind: "text",
    cliEncoding: "value",
    presetSupport: "supported",
  });

export const LlamaArgumentCompatibilitySchema = z
  .object({
    metadataSource: z.enum(["registry", "binary"]),
    presentInBinary: z.boolean(),
    binaryPrimaryName: z.string().nullable(),
    binaryNames: z.array(z.string()),
  })
  .default({
    metadataSource: "binary",
    presentInBinary: true,
    binaryPrimaryName: null,
    binaryNames: [],
  });

export const LlamaArgumentDocIndexSchema = z
  .object({
    exists: z.boolean().default(false),
    path: z.string().nullable().default(null),
    summary: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .default({
    exists: false,
    path: null,
    summary: null,
    updatedAt: null,
  });

export const ArgumentOptionSchema = z.object({
  primaryName: z.string(),
  names: z.array(z.string()),
  category: z.string(),
  valueHint: z.string().nullable(),
  valueType: ArgumentValueTypeSchema,
  env: z.array(z.string()),
  allowedValues: z.array(z.string()),
  help: z.string(),
  helpRu: z.string(),
  helpRuSource: z.enum(["registry", "builtin", "fallback"]),
  doc: LlamaArgumentDocIndexSchema,
  control: ArgumentControlSchema,
  compatibility: LlamaArgumentCompatibilitySchema,
  deprecated: z.boolean(),
});

export const ArgumentCatalogSchema = z.object({
  binaryPath: z.string(),
  generatedAt: z.string(),
  source: z.object({
    kind: z.literal("help"),
    command: z.array(z.string()),
    hash: z.string(),
    binarySize: z.number(),
    binaryModifiedAt: z.string(),
  }),
  cache: z.object({
    hit: z.boolean(),
    refreshed: z.boolean(),
    stale: z.boolean(),
  }),
  options: z.array(ArgumentOptionSchema),
});

export const ArgumentDefaultValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "flag",
  "list",
  "null",
]);

export const ArgumentDefaultSchema = z.object({
  key: z.string().min(1),
  value: z.string().default(""),
  valueType: ArgumentDefaultValueTypeSchema.default("string"),
});

export const ArgumentDefaultsSchema = z.object({
  instance: z.array(ArgumentDefaultSchema).default([]),
  updatedAt: z.string().nullable().default(null),
});

export const LlamaArgumentEngineeringDocSchema = z.object({
  primaryName: z.string(),
  path: z.string(),
  exists: z.boolean(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  updatedAt: z.string().nullable(),
  frontmatter: z.record(z.string(), z.unknown()),
  markdown: z.string(),
});

export const LlamaArgumentHelpSourceSnapshotSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  hash: z.string().nullable(),
  llamaCppCommit: z.string().nullable(),
  updatedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const LlamaArgumentHelpSourceSyncSchema = z.object({
  sourcePath: z.string(),
  block: z.string(),
  snapshotPath: z.string(),
  metadataPath: z.string(),
  stored: LlamaArgumentHelpSourceSnapshotSchema,
  current: LlamaArgumentHelpSourceSnapshotSchema,
  inSync: z.boolean().nullable(),
  phantomRows: z.array(z.string()).nullable(),
});

export const LlamaArgumentDocsSyncReportSchema = z.object({
  checkedAt: z.string(),
  source: LlamaSourceStatusSchema,
  helpSource: LlamaArgumentHelpSourceSyncSchema,
  docsDirectory: z.string(),
});

export const LlamaArgumentHelpDiffSchema = z.object({
  diff: z.string(),
});

export const SourceSyncDivergenceSchema = z.object({
  kind: z.string().min(1),
  severity: z.enum(["info", "warning"]),
  label: z.string(),
  detail: z.string().nullable(),
});

export const SourceSyncSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  sourcePath: z.string(),
  status: z.enum(["in-sync", "drift", "error"]),
  summary: z.string(),
  error: z.string().nullable(),
  divergences: z.array(SourceSyncDivergenceSchema),
});

export const SourceSyncReportStatusSchema = z.enum([
  "unavailable",
  "in-sync",
  "drift",
  "error",
]);

export const SourceSyncReportSchema = z.object({
  sourceId: SourceRepositoryIdSchema,
  status: SourceSyncReportStatusSchema,
  checkedAt: z.string(),
  repository: SourceRepositoryStatusSchema,
  repoPath: z.string(),
  commit: z.string().nullable(),
  sections: z.array(SourceSyncSectionSchema),
});

export const LlamaSourceSyncDivergenceSchema = SourceSyncDivergenceSchema;
export const LlamaSourceSyncSectionSchema = SourceSyncSectionSchema;
export const LlamaSourceSyncReportSchema = SourceSyncReportSchema.extend({
  llamaCppCommit: z.string().nullable(),
});

export const NetworkInterfaceAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
  family: z.enum(["IPv4", "IPv6"]),
  internal: z.boolean(),
  cidr: z.string().nullable(),
  mac: z.string().nullable(),
});

export const NetworkInterfacesResultSchema = z.object({
  interfaces: z.array(NetworkInterfaceAddressSchema),
});

export const SystemMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  usedRatio: z.number().min(0).max(1),
  source: z.enum(["proc-meminfo", "node-os"]),
});

export const SystemAcceleratorSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string().nullable(),
  kind: z.enum(["gpu", "accelerator"]),
  totalMemoryBytes: z.number().int().nonnegative().nullable(),
  availableMemoryBytes: z.number().int().nonnegative().nullable(),
  memoryUsedRatio: z.number().min(0).max(1).nullable(),
  utilizationPercent: z.number().min(0).max(100).nullable(),
  temperatureC: z.number().nullable(),
  numaNode: z.number().int().min(0).nullable(),
  source: z.string(),
});

export const NumaNodeSchema = z.object({
  id: z.number().int().min(0),
  cpus: z.string(),
  cpuCount: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  memFreeBytes: z.number().int().nonnegative().default(0),
  filePagesBytes: z.number().int().nonnegative().default(0),
  online: z.boolean(),
});

export const NumaCapabilitiesSchema = z.object({
  nodes: z.array(NumaNodeSchema),
  bind: z.boolean(),
  interleave: z.boolean(),
});

export const SystemDiskDeviceSchema = z.object({
  name: z.string(),
  model: z.string().nullable(),
  type: z.enum(["ssd", "hdd", "unknown"]),
  readBytesPerSec: z.number().nonnegative().nullable(),
  writeBytesPerSec: z.number().nonnegative().nullable(),
  readIops: z.number().nonnegative().nullable(),
  writeIops: z.number().nonnegative().nullable(),
  utilPercent: z.number().min(0).max(100).nullable(),
  avgReadLatencyMs: z.number().nonnegative().nullable(),
  avgWriteLatencyMs: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const SystemIoPressureSchema = z.object({
  avg10: z.number().min(0).max(100),
  avg60: z.number().min(0).max(100),
});

export const SystemDiskActivitySchema = z.object({
  devices: z.array(SystemDiskDeviceSchema),
  totalReadBytesPerSec: z.number().nonnegative().nullable(),
  totalWriteBytesPerSec: z.number().nonnegative().nullable(),
  ioPressure: SystemIoPressureSchema.nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemRdmaActivitySchema = z.object({
  device: z.string(),
  port: z.number().int().positive(),
  receiveBytesPerSec: z.number().nonnegative().nullable(),
  transmitBytesPerSec: z.number().nonnegative().nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemStorageSpaceSchema = z.object({
  mountPath: z.string(),
  source: z.string(),
  fsType: z.string(),
  kind: z.enum(["local", "beegfs"]),
  cfgFile: z.string().nullable(),
  totalBytes: z.number().nonnegative().nullable(),
  freeBytes: z.number().nonnegative().nullable(),
  totalInodes: z.number().nonnegative().nullable(),
  freeInodes: z.number().nonnegative().nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const SystemStorageResourcesSchema = z.object({
  checkedAt: z.string(),
  filesystems: z.array(SystemStorageSpaceSchema),
  rdma: SystemRdmaActivitySchema.nullable().default(null),
});

export const SystemCpuCoreSchema = z.object({
  id: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
});

export const SystemCpuActivitySchema = z.object({
  usagePercent: z.number().min(0).max(100),
  userPercent: z.number().min(0).max(100),
  systemPercent: z.number().min(0).max(100),
  ioWaitPercent: z.number().min(0).max(100),
  stealPercent: z.number().min(0).max(100),
  cores: z.array(SystemCpuCoreSchema),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemNetworkInterfaceSchema = z.object({
  name: z.string(),
  rxBytesPerSec: z.number().nonnegative().nullable(),
  txBytesPerSec: z.number().nonnegative().nullable(),
  rxPacketsPerSec: z.number().nonnegative().nullable(),
  txPacketsPerSec: z.number().nonnegative().nullable(),
  speedMbps: z.number().nonnegative().nullable(),
  up: z.boolean(),
});

export const SystemNetworkActivitySchema = z.object({
  interfaces: z.array(SystemNetworkInterfaceSchema),
  totalRxBytesPerSec: z.number().nonnegative().nullable(),
  totalTxBytesPerSec: z.number().nonnegative().nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemResourcesSchema = z.object({
  checkedAt: z.string(),
  memory: SystemMemorySchema,
  accelerators: z.array(SystemAcceleratorSchema),
  disk: SystemDiskActivitySchema.nullable(),
  storage: SystemStorageResourcesSchema.nullable().default(null),
  cpu: SystemCpuActivitySchema.nullable().default(null),
  network: SystemNetworkActivitySchema.nullable().default(null),
  numa: NumaCapabilitiesSchema,
  tools: z.object({ uv: UvToolStatusSchema }).optional(),
});

export const SystemMetricsGpuSampleSchema = z.object({
  id: z.string(),
  utilizationPercent: z.number().nullable(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  temperatureC: z.number().nullable(),
});

export const SystemMetricsDiskSampleSchema = SystemDiskDeviceSchema.pick({
  name: true,
  utilPercent: true,
  readBytesPerSec: true,
  writeBytesPerSec: true,
});

export const SystemMetricsNetworkSampleSchema =
  SystemNetworkInterfaceSchema.pick({
    name: true,
    rxBytesPerSec: true,
    txBytesPerSec: true,
  });

export const SystemMetricsRdmaSampleSchema = SystemRdmaActivitySchema.pick({
  device: true,
  port: true,
  receiveBytesPerSec: true,
  transmitBytesPerSec: true,
});

export const SystemMetricsSampleSchema = z.object({
  at: z.number().int().nonnegative(),
  cpuPercent: z.number().nullable(),
  memoryUsedBytes: z.number().nonnegative(),
  memoryTotalBytes: z.number().nonnegative(),
  gpus: z.array(SystemMetricsGpuSampleSchema),
  disks: z.array(SystemMetricsDiskSampleSchema),
  network: z.array(SystemMetricsNetworkSampleSchema),
  rdma: SystemMetricsRdmaSampleSchema.nullable().default(null),
});

export const SystemMetricsWindowSchema = z.enum([
  "live",
  "hour",
  "day",
  "month",
]);

export const SystemMetricsCoarseWindowSchema =
  SystemMetricsWindowSchema.exclude(["live"]);

export const SystemMetricsHistorySchema = z.object({
  window: SystemMetricsWindowSchema,
  intervalMs: z.number().int().positive(),
  capacity: z.number().int().positive(),
  samples: z.array(SystemMetricsSampleSchema),
});

export const SYSTEM_METRICS_TIERS: Record<
  z.infer<typeof SystemMetricsWindowSchema>,
  { intervalMs: number; capacity: number }
> = {
  live: { intervalMs: 1_000, capacity: 300 },
  hour: { intervalMs: 10_000, capacity: 360 },
  day: { intervalMs: 60_000, capacity: 1_440 },
  month: { intervalMs: 1_800_000, capacity: 1_440 },
};

export const HostPackageManagerSchema = z.enum([
  "apt",
  "dnf",
  "pacman",
  "zypper",
  "apk",
  "unknown",
]);

export const PrerequisiteCheckKindSchema = z.enum([
  "executable",
  "pkg-config",
  "device",
  "capability",
]);

export const PrerequisiteSeveritySchema = z.enum(["required", "recommended"]);

export const PrerequisiteStatusSchema = z.enum([
  "ok",
  "out-of-path",
  "missing",
  "unknown",
]);

export const PrerequisiteRemediationSchema = z.object({
  packages: z.array(z.string()),
  installCommand: z.string().nullable(),
  commands: z.array(z.string()),
  includeInInstallPlan: z.boolean(),
  rebootRequired: z.boolean(),
  docPath: z.string().nullable(),
  note: z.string().nullable(),
});

export const PrerequisiteCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: PrerequisiteCheckKindSchema,
  severity: PrerequisiteSeveritySchema,
  status: PrerequisiteStatusSchema,
  blocks: z.array(z.string()),
  impact: z.string(),
  detail: z.string().nullable(),
  version: z.string().nullable(),
  remediation: PrerequisiteRemediationSchema,
});

export const PrerequisiteGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  checks: z.array(PrerequisiteCheckSchema),
});

export const PrerequisiteHostSchema = z.object({
  platform: z.string(),
  osName: z.string().nullable(),
  osId: z.string().nullable(),
  packageManager: HostPackageManagerSchema,
  runMode: AppRunModeSchema,
  path: z.array(z.string()),
  autoRepairedPath: z.array(z.string()),
});

export const PrerequisiteSummarySchema = z.object({
  ok: z.number().int().nonnegative(),
  missingRequired: z.number().int().nonnegative(),
  missingRecommended: z.number().int().nonnegative(),
  outOfPath: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  unresolvedRequired: z.number().int().nonnegative(),
});

export const PrerequisiteInstallPlanSchema = z.object({
  packageManager: HostPackageManagerSchema,
  requiredCommand: z.string().nullable(),
  allCommand: z.string().nullable(),
});

export const PrerequisiteInstallCapabilitySchema = z.object({
  available: z.boolean(),
  method: z.enum(["root", "passwordless-sudo"]).nullable(),
  reason: z.string().nullable(),
});

export const PrerequisiteInstallScopeSchema = z.enum(["required", "all"]);

export const PrerequisiteInstallStartSchema = z.union([
  z.object({ scope: PrerequisiteInstallScopeSchema }),
  z.object({ checkId: z.string().min(1) }),
]);

export const PrerequisiteInstallRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
]);

export const PrerequisiteInstallRunSchema = z.object({
  id: z.string(),
  request: PrerequisiteInstallStartSchema,
  command: z.string(),
  status: PrerequisiteInstallRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  log: z.string(),
});

export const PrerequisiteReportSchema = z.object({
  checkedAt: z.string(),
  host: PrerequisiteHostSchema,
  groups: z.array(PrerequisiteGroupSchema),
  summary: PrerequisiteSummarySchema,
  install: PrerequisiteInstallPlanSchema,
  installRunner: PrerequisiteInstallCapabilitySchema,
});

export const FleetNodeResultMetaSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  self: z.boolean(),
  baseUrl: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const FleetSystemEntrySchema = FleetNodeResultMetaSchema.extend({
  data: SystemResourcesSchema.nullable(),
});
export type FleetSystemEntry = z.infer<typeof FleetSystemEntrySchema>;

export const FleetResourcesPayloadSchema = z.object({
  pools: z.array(MemoryPoolViewSchema),
  ledger: ResourceLedgerSchema,
  detected: SystemResourcesSchema,
});
export type FleetResourcesPayload = z.infer<typeof FleetResourcesPayloadSchema>;

export const FleetResourcesEntrySchema = FleetNodeResultMetaSchema.extend({
  data: FleetResourcesPayloadSchema.nullable(),
});
export type FleetResourcesEntry = z.infer<typeof FleetResourcesEntrySchema>;

export const AuthStateSchema = z.object({
  enabled: z.boolean(),
  authenticated: z.boolean(),
});

export const AdminLoginSchema = z.object({
  password: z.string().min(1),
});

export const PublicProxyModelSchema = z.object({
  modelId: z.string(),
  status: ApiProxyPublicModelStatusSchema,
});

export const PublicStatusSchema = z.object({
  service: z.object({
    ok: z.boolean(),
    authRequired: z.boolean(),
    checkedAt: z.string(),
  }),
  models: z.object({
    total: z.number().int().nonnegative(),
    loaded: z.number().int().nonnegative(),
    activeRequests: z.number().int().nonnegative(),
    queuedRequests: z.number().int().nonnegative(),
    items: z.array(PublicProxyModelSchema),
  }),
});

export const GgufBaseModelSchema = z.object({
  name: z.string().nullable(),
  organization: z.string().nullable(),
  repoUrl: z.string().nullable(),
});

export const GgufMetadataSchema = z.object({
  name: z.string().nullable(),
  architecture: z.string().nullable(),
  modelType: z.string().nullable(),
  poolingType: z.number().nullable(),
  causalAttention: z.boolean().nullable(),
  hasClassifierHead: z.boolean().nullable(),
  quantization: z.string().nullable(),
  quantizationVersion: z.number().nullable(),
  sizeLabel: z.string().nullable(),
  basename: z.string().nullable(),
  finetune: z.string().nullable(),
  license: z.string().nullable(),
  licenseLink: z.string().nullable(),
  repoUrl: z.string().nullable(),
  version: z.string().nullable(),
  quantizedBy: z.string().nullable(),
  tags: z.array(z.string()),
  baseModels: z.array(GgufBaseModelSchema),
  parameterCount: z.number().nullable(),
  contextLength: z.number().nullable(),
  embeddingLength: z.number().nullable(),
  blockCount: z.number().nullable(),
  leadingDenseBlockCount: z.number().nullable(),
  feedForwardLength: z.number().nullable(),
  expertCount: z.number().nullable(),
  expertUsedCount: z.number().nullable(),
  expertSharedCount: z.number().nullable(),
  expertFeedForwardLength: z.number().nullable(),
  headCount: z.number().nullable(),
  headCountKv: z.number().nullable(),
  attentionKeyLength: z.number().nullable(),
  attentionValueLength: z.number().nullable(),
  attentionKeyLengthMla: z.number().nullable(),
  attentionValueLengthMla: z.number().nullable(),
  slidingWindow: z.number().nullable(),
  slidingWindowPattern: z.union([z.number(), z.array(z.boolean())]).nullable(),
  sharedKvLayers: z.number().nullable(),
  nextnPredictLayers: z.number().nullable(),
  shortConvCacheLength: z.number().nullable(),
  ssmConvKernel: z.number().nullable(),
  ssmGroupCount: z.number().nullable(),
  ssmInnerSize: z.number().nullable(),
  ssmStateSize: z.number().nullable(),
  wkvHeadSize: z.number().nullable(),
  tokenShiftCount: z.number().nullable(),
  kdaHeadDim: z.number().nullable(),
  ropeFreqBase: z.number().nullable(),
  ropeScalingType: z.string().nullable(),
  ropeScalingFactor: z.number().nullable(),
  ropeScalingOrigCtxLen: z.number().nullable(),
  tokenizerModel: z.string().nullable(),
  tokenizerPre: z.string().nullable(),
  addBosToken: z.boolean().nullable(),
  addEosToken: z.boolean().nullable(),
  hasChatTemplate: z.boolean(),
  vocabularySize: z.number().nullable(),
  samplingTemp: z.number().nullable(),
  samplingTopK: z.number().nullable(),
  samplingTopP: z.number().nullable(),
  imatrixDataset: z.string().nullable(),
  imatrixEntries: z.number().nullable(),
  imatrixChunks: z.number().nullable(),
});

export const GgufModelSchema = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  isMmproj: z.boolean(),
  mmprojPaths: z.array(z.string()),
  metadata: GgufMetadataSchema,
  error: z.string().optional(),
});

export const ModelScanRootSourceSchema = z.enum([
  "settings",
  "catalog",
  "llama-cache",
]);

export const ModelScanRootSchema = z.object({
  path: z.string(),
  label: z.string(),
  source: ModelScanRootSourceSchema,
  refId: z.string().nullable(),
  exists: z.boolean(),
});

export const ModelScanResultSchema = z.object({
  roots: z.array(ModelScanRootSchema),
  models: z.array(GgufModelSchema),
  scannedAt: z.string(),
  cache: z.object({
    hits: z.number(),
    misses: z.number(),
  }),
  fromCache: z.boolean().optional(),
});

export const ModelScanSettingsSchema = z.object({
  directory: z.string(),
  maxDepth: z.number().int().min(0).max(16),
});

export const AppSettingsFileSchema = z
  .object({
    modelScan: ModelScanSettingsSchema.optional(),
    sourceRepositories: z.array(SourceRepositorySpecSchema).optional(),
    llamaSource: LlamaSourceSettingsSchema.optional(),
    build: BuildSettingsSchema.omit({ repoPath: true }).optional(),
    environments: EnvironmentRepositorySettingsSchema.optional(),
  })
  .default({});

export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;

export const ModelPresetEntrySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  modelPath: z.string(),
  mmprojPath: z.string().nullable(),
  extraArgs: z.record(z.string(), z.string()).default({}),
});

export const ModelPresetFileSchema = z.object({
  globalArgs: z.record(z.string(), z.string()).default({}),
  rootArgs: z.record(z.string(), z.string()).default({}),
  entries: z.array(ModelPresetEntrySchema).default([]),
});

export const PresetDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  section: z.string().nullable(),
  key: z.string().nullable(),
  line: z.number().int().nullable(),
});

export const ModelPresetSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  mtimeMs: z.number().nullable(),
});

export const PresetValidationSchema = z.object({
  name: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
});

export const ModelPresetDocumentSchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
  file: ModelPresetFileSchema,
  content: z.string(),
  mtimeMs: z.number().nullable(),
});

export const ModelPresetWriteSchema = z.object({
  content: z.string(),
  expectedMtimeMs: z.number().nullable(),
  force: z.boolean().default(false),
});

export const ModelPresetCreateSchema = z.object({
  name: PresetNameSchema,
});

export type SourceRepositoryId = z.infer<typeof SourceRepositoryIdSchema>;
export type SourceRepositoryLocation = z.infer<
  typeof SourceRepositoryLocationSchema
>;
export type SourceRepositorySpec = z.infer<typeof SourceRepositorySpecSchema>;
export type SourceRepositorySettingsUpdate = z.infer<
  typeof SourceRepositorySettingsUpdateSchema
>;
export type SourceRepositoryClone = z.infer<typeof SourceRepositoryCloneSchema>;
export type SourceRepositoryState = z.infer<typeof SourceRepositoryStateSchema>;
export type SourceRepositoryStatus = z.infer<
  typeof SourceRepositoryStatusSchema
>;
export type SourceRepositoryOperationResult = z.infer<
  typeof SourceRepositoryOperationResultSchema
>;
export type SourceRepositoryOperationKind = z.infer<
  typeof SourceRepositoryOperationKindSchema
>;
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;
export type SourceRepositoryOperationStatus = z.infer<
  typeof SourceRepositoryOperationStatusSchema
>;
export type SourceRepositoryOperationPhase = z.infer<
  typeof SourceRepositoryOperationPhaseSchema
>;
export type SourceRepositoryOperationJob = z.infer<
  typeof SourceRepositoryOperationJobSchema
>;
export type LlamaArgumentHelpSourceSnapshot = z.infer<
  typeof LlamaArgumentHelpSourceSnapshotSchema
>;
export type LlamaArgumentHelpSourceSync = z.infer<
  typeof LlamaArgumentHelpSourceSyncSchema
>;
export type LlamaArgumentDocsSyncReport = z.infer<
  typeof LlamaArgumentDocsSyncReportSchema
>;
export type LlamaArgumentHelpDiff = z.infer<typeof LlamaArgumentHelpDiffSchema>;
export type SourceSyncDivergence = z.infer<typeof SourceSyncDivergenceSchema>;
export type SourceSyncSection = z.infer<typeof SourceSyncSectionSchema>;
export type SourceSyncReportStatus = z.infer<
  typeof SourceSyncReportStatusSchema
>;
export type SourceSyncReport = z.infer<typeof SourceSyncReportSchema>;
export type LlamaSourceSyncDivergence = z.infer<
  typeof LlamaSourceSyncDivergenceSchema
>;
export type LlamaSourceSyncSection = z.infer<
  typeof LlamaSourceSyncSectionSchema
>;
export type LlamaSourceSyncReport = z.infer<typeof LlamaSourceSyncReportSchema>;
export type BuildSettings = z.infer<typeof BuildSettingsSchema>;
export type BuildJobStatus = z.infer<typeof BuildJobStatusSchema>;
export type BuildJobStepName = z.infer<typeof BuildJobStepNameSchema>;
export type BuildJobStepStatus = z.infer<typeof BuildJobStepStatusSchema>;
export type BuildJobStep = z.infer<typeof BuildJobStepSchema>;
export type BuildJob = z.infer<typeof BuildJobSchema>;
export type BuildJobStart = z.infer<typeof BuildJobStartSchema>;
export type BuildLogTail = z.infer<typeof BuildLogTailSchema>;
export type EnvironmentInstallSource = z.infer<
  typeof EnvironmentInstallSourceSchema
>;
export type VllmEnvironmentInstallSource = z.infer<
  typeof VllmEnvironmentInstallSourceSchema
>;
export type KTransformersWheelArtifact = z.infer<
  typeof KTransformersWheelArtifactSchema
>;
export type KTransformersEnvironmentInstallSource = z.infer<
  typeof KTransformersEnvironmentInstallSourceSchema
>;
export type EnvironmentEngine = z.infer<typeof EnvironmentEngineSchema>;
export type EnvironmentRepositorySettings = z.infer<
  typeof EnvironmentRepositorySettingsSchema
>;
export type EnvironmentCreate = z.infer<typeof EnvironmentCreateSchema>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;
export type EnvironmentStatus = z.infer<typeof EnvironmentStatusSchema>;
export type PackageIndexFile = z.infer<typeof PackageIndexFileSchema>;
export type PackageIndexVersion = z.infer<typeof PackageIndexVersionSchema>;
export type PackageIndexLookupStatus = z.infer<
  typeof PackageIndexLookupStatusSchema
>;
export type EnvironmentIndexVersions = z.infer<
  typeof EnvironmentIndexVersionsSchema
>;
export type EnvironmentRecord = z.infer<typeof EnvironmentRecordSchema>;
export type EnvironmentJobStatus = z.infer<typeof EnvironmentJobStatusSchema>;
export type EnvironmentJobStepName = z.infer<
  typeof EnvironmentJobStepNameSchema
>;
export type EnvironmentJobStep = z.infer<typeof EnvironmentJobStepSchema>;
export type EnvironmentJob = z.infer<typeof EnvironmentJobSchema>;
export type EnvironmentLogTail = z.infer<typeof EnvironmentLogTailSchema>;
export type UvToolStatus = z.infer<typeof UvToolStatusSchema>;
export type AppRunMode = z.infer<typeof AppRunModeSchema>;
export type AppVersion = z.infer<typeof AppVersionSchema>;
export type UpdateJobStatus = z.infer<typeof UpdateJobStatusSchema>;
export type UpdateJobStepName = z.infer<typeof UpdateJobStepNameSchema>;
export type UpdateJobStepStatus = z.infer<typeof UpdateJobStepStatusSchema>;
export type UpdateJobStep = z.infer<typeof UpdateJobStepSchema>;
export type UpdateJob = z.infer<typeof UpdateJobSchema>;
export type UpdateJobStart = z.infer<typeof UpdateJobStartSchema>;
export type UpdateLogTail = z.infer<typeof UpdateLogTailSchema>;
export type UpdateUpstream = z.infer<typeof UpdateUpstreamSchema>;
export type UpdateFleetNode = z.infer<typeof UpdateFleetNodeSchema>;
export type UpdateFleet = z.infer<typeof UpdateFleetSchema>;
export type ConfigGitFileStatus = z.infer<typeof ConfigGitFileStatusSchema>;
export type ConfigGitBranch = z.infer<typeof ConfigGitBranchSchema>;
export type ConfigGitStatus = z.infer<typeof ConfigGitStatusSchema>;
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
export type ArgumentValueType = z.infer<typeof ArgumentValueTypeSchema>;
export type ArgumentControlKind = z.infer<typeof ArgumentControlKindSchema>;
export type ArgumentCliEncoding = z.infer<typeof ArgumentCliEncodingSchema>;
export type LlamaArgumentPresetSupport = z.infer<
  typeof LlamaArgumentPresetSupportSchema
>;
export type ArgumentControl = z.infer<typeof ArgumentControlSchema>;
export type LlamaArgumentCompatibility = z.infer<
  typeof LlamaArgumentCompatibilitySchema
>;
export type LlamaArgumentDocIndex = z.infer<typeof LlamaArgumentDocIndexSchema>;
export type ArgumentOption = z.infer<typeof ArgumentOptionSchema>;
export type ArgumentCatalog = z.infer<typeof ArgumentCatalogSchema>;
export type ArgumentDefaultValueType = z.infer<
  typeof ArgumentDefaultValueTypeSchema
>;
export type ArgumentDefault = z.infer<typeof ArgumentDefaultSchema>;
export type ArgumentDefaults = z.infer<typeof ArgumentDefaultsSchema>;
export type LlamaArgumentEngineeringDoc = z.infer<
  typeof LlamaArgumentEngineeringDocSchema
>;
export type NetworkInterfaceAddress = z.infer<
  typeof NetworkInterfaceAddressSchema
>;
export type NetworkInterfacesResult = z.infer<
  typeof NetworkInterfacesResultSchema
>;
export type SystemMemory = z.infer<typeof SystemMemorySchema>;
export type SystemAccelerator = z.infer<typeof SystemAcceleratorSchema>;
export type SystemDiskDevice = z.infer<typeof SystemDiskDeviceSchema>;
export type SystemIoPressure = z.infer<typeof SystemIoPressureSchema>;
export type SystemDiskActivity = z.infer<typeof SystemDiskActivitySchema>;
export type SystemRdmaActivity = z.infer<typeof SystemRdmaActivitySchema>;
export type SystemStorageSpace = z.infer<typeof SystemStorageSpaceSchema>;
export type SystemStorageResources = z.infer<
  typeof SystemStorageResourcesSchema
>;
export type SystemCpuCore = z.infer<typeof SystemCpuCoreSchema>;
export type SystemCpuActivity = z.infer<typeof SystemCpuActivitySchema>;
export type SystemNetworkInterface = z.infer<
  typeof SystemNetworkInterfaceSchema
>;
export type SystemNetworkActivity = z.infer<typeof SystemNetworkActivitySchema>;
export type SystemMetricsGpuSample = z.infer<
  typeof SystemMetricsGpuSampleSchema
>;
export type SystemMetricsDiskSample = z.infer<
  typeof SystemMetricsDiskSampleSchema
>;
export type SystemMetricsNetworkSample = z.infer<
  typeof SystemMetricsNetworkSampleSchema
>;
export type SystemMetricsRdmaSample = z.infer<
  typeof SystemMetricsRdmaSampleSchema
>;
export type SystemMetricsSample = z.infer<typeof SystemMetricsSampleSchema>;
export type SystemMetricsWindow = z.infer<typeof SystemMetricsWindowSchema>;
export type SystemMetricsCoarseWindow = z.infer<
  typeof SystemMetricsCoarseWindowSchema
>;
export type SystemMetricsHistory = z.infer<typeof SystemMetricsHistorySchema>;
export type NumaNode = z.infer<typeof NumaNodeSchema>;
export type NumaCapabilities = z.infer<typeof NumaCapabilitiesSchema>;
export type SystemResources = z.infer<typeof SystemResourcesSchema>;
export type HostPackageManager = z.infer<typeof HostPackageManagerSchema>;
export type PrerequisiteCheckKind = z.infer<typeof PrerequisiteCheckKindSchema>;
export type PrerequisiteSeverity = z.infer<typeof PrerequisiteSeveritySchema>;
export type PrerequisiteStatus = z.infer<typeof PrerequisiteStatusSchema>;
export type PrerequisiteRemediation = z.infer<
  typeof PrerequisiteRemediationSchema
>;
export type PrerequisiteCheck = z.infer<typeof PrerequisiteCheckSchema>;
export type PrerequisiteGroup = z.infer<typeof PrerequisiteGroupSchema>;
export type PrerequisiteHost = z.infer<typeof PrerequisiteHostSchema>;
export type PrerequisiteSummary = z.infer<typeof PrerequisiteSummarySchema>;
export type PrerequisiteInstallPlan = z.infer<
  typeof PrerequisiteInstallPlanSchema
>;
export type PrerequisiteInstallCapability = z.infer<
  typeof PrerequisiteInstallCapabilitySchema
>;
export type PrerequisiteInstallScope = z.infer<
  typeof PrerequisiteInstallScopeSchema
>;
export type PrerequisiteInstallStart = z.infer<
  typeof PrerequisiteInstallStartSchema
>;
export type PrerequisiteInstallRunStatus = z.infer<
  typeof PrerequisiteInstallRunStatusSchema
>;
export type PrerequisiteInstallRun = z.infer<
  typeof PrerequisiteInstallRunSchema
>;
export type PrerequisiteReport = z.infer<typeof PrerequisiteReportSchema>;
export type AuthState = z.infer<typeof AuthStateSchema>;
export type AdminLogin = z.infer<typeof AdminLoginSchema>;
export type PublicProxyModel = z.infer<typeof PublicProxyModelSchema>;
export type PublicStatus = z.infer<typeof PublicStatusSchema>;
export type GgufBaseModel = z.infer<typeof GgufBaseModelSchema>;
export type GgufMetadata = z.infer<typeof GgufMetadataSchema>;
export type GgufModel = z.infer<typeof GgufModelSchema>;

export type GgufModelRole = "generative" | "embedding" | "reranker";

export const GGUF_POOLING_TYPE_LABELS: Record<number, string> = {
  [-1]: "unspecified",
  0: "none",
  1: "mean",
  2: "cls",
  3: "last",
  4: "rank",
};

export function ggufPoolingTypeLabel(
  value: number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return GGUF_POOLING_TYPE_LABELS[value] ?? `type ${value}`;
}

export function ggufModelRole(
  metadata: Pick<
    GgufMetadata,
    "poolingType" | "causalAttention" | "hasClassifierHead"
  >,
): GgufModelRole {
  if (metadata.poolingType === 4 || metadata.hasClassifierHead) {
    return "reranker";
  }
  if (metadata.causalAttention === false) {
    return "embedding";
  }
  if (metadata.poolingType !== null && metadata.poolingType >= 1) {
    return "embedding";
  }
  return "generative";
}
export type ModelScanRootSource = z.infer<typeof ModelScanRootSourceSchema>;
export type ModelScanRoot = z.infer<typeof ModelScanRootSchema>;
export type ModelScanResult = z.infer<typeof ModelScanResultSchema>;
export type ModelScanSettings = z.infer<typeof ModelScanSettingsSchema>;
export type ModelPresetEntry = z.infer<typeof ModelPresetEntrySchema>;
export type ModelPresetFile = z.infer<typeof ModelPresetFileSchema>;
export type PresetDiagnostic = z.infer<typeof PresetDiagnosticSchema>;
export type ModelPresetSummary = z.infer<typeof ModelPresetSummarySchema>;
export type PresetValidation = z.infer<typeof PresetValidationSchema>;
export type ModelPresetDocument = z.infer<typeof ModelPresetDocumentSchema>;
export type ModelPresetWrite = z.infer<typeof ModelPresetWriteSchema>;
export type ModelPresetCreate = z.infer<typeof ModelPresetCreateSchema>;
