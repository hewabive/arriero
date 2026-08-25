import { z } from "zod";

import { BuildJobStepStatusSchema } from "./build.js";
import { stripKeys } from "./config-git.js";
import { BackgroundJobStatusSchema } from "./jobs.js";
import { credentialFreeUrlSchema } from "./registries.js";
import type { ComputeCapability } from "./system.js";

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

export const EnvironmentEngineSchema = z.enum([
  "vllm",
  "sglang",
  "ktransformers",
  "open-webui",
]);

export type CudaEnvironmentEngine = "vllm" | "sglang" | "ktransformers";

export const ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY: Record<
  CudaEnvironmentEngine,
  ComputeCapability
> = {
  vllm: { major: 7, minor: 5 },
  sglang: { major: 7, minor: 5 },
  ktransformers: { major: 7, minor: 5 },
};

export const ENVIRONMENT_ENGINE_LABELS: Record<
  z.infer<typeof EnvironmentEngineSchema>,
  string
> = {
  vllm: "vLLM",
  sglang: "SGLang",
  ktransformers: "KTransformers",
  "open-webui": "Open WebUI",
};

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

const SglangEnvironmentCreateObjectSchema = z.object({
  ...EnvironmentCommonShape,
  engine: z.literal("sglang"),
  variant: z.literal("cuda").default("cuda"),
  pythonVersion: PythonVersionSchema.default("3.12"),
  source: VllmEnvironmentInstallSourceSchema.default({
    kind: "pypi",
    extras: ["all"],
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

export const OPEN_WEBUI_DEFAULT_PYTHON_VERSION = "3.12";

const OpenWebuiEnvironmentCreateObjectSchema = z.object({
  ...EnvironmentCommonShape,
  engine: z.literal("open-webui"),
  variant: z.literal("cpu").default("cpu"),
  pythonVersion: z
    .enum(["3.11", "3.12"])
    .default(OPEN_WEBUI_DEFAULT_PYTHON_VERSION),
  source: VllmEnvironmentInstallSourceSchema.default({
    kind: "pypi",
    extras: [],
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
  SglangEnvironmentCreateObjectSchema,
  KTransformersEnvironmentCreateObjectSchema,
  OpenWebuiEnvironmentCreateObjectSchema,
]);

export const EnvironmentCreateSchema = z.preprocess(
  withLegacyVllmEngine,
  EnvironmentCreateUnionSchema,
);

const EnvironmentSpecMetadataShape = {
  id: z.string().min(1),
};

export const ENVIRONMENT_MACHINE_STATE_KEYS = [
  "pathCatalogEntryId",
  "createdAt",
  "updatedAt",
] as const;

const LEGACY_ENVIRONMENT_SPEC_KEYS = [
  ...ENVIRONMENT_MACHINE_STATE_KEYS,
  "pythonProvisioning",
  "pythonMirrorUrl",
] as const;

function normalizeStoredEnvironmentSpec(value: unknown) {
  return stripKeys(withLegacyVllmEngine(value), LEGACY_ENVIRONMENT_SPEC_KEYS);
}

export const EnvironmentSpecSchema = z.preprocess(
  normalizeStoredEnvironmentSpec,
  z.discriminatedUnion("engine", [
    VllmEnvironmentCreateObjectSchema.extend(
      EnvironmentSpecMetadataShape,
    ).catchall(z.unknown()),
    SglangEnvironmentCreateObjectSchema.extend(
      EnvironmentSpecMetadataShape,
    ).catchall(z.unknown()),
    KTransformersEnvironmentCreateObjectSchema.extend(
      EnvironmentSpecMetadataShape,
    ).catchall(z.unknown()),
    OpenWebuiEnvironmentCreateObjectSchema.extend(
      EnvironmentSpecMetadataShape,
    ).catchall(z.unknown()),
  ]),
);

export const EnvironmentMachineStateEntrySchema = z.object({
  envId: z.string().min(1),
  pathCatalogEntryId: z.string().min(1).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const EnvironmentMachineStateSchema = z.array(
  EnvironmentMachineStateEntrySchema,
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
  createdAt: z.string().nullable().default(null),
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
    SglangEnvironmentCreateObjectSchema.extend(EnvironmentRecordShape),
    KTransformersEnvironmentCreateObjectSchema.extend(EnvironmentRecordShape),
    OpenWebuiEnvironmentCreateObjectSchema.extend(EnvironmentRecordShape),
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

export const UvToolStatusSchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  reason: z.string().nullable(),
});

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
export type EnvironmentCreateInput = z.input<
  typeof EnvironmentCreateUnionSchema
>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;
export type EnvironmentMachineStateEntry = z.infer<
  typeof EnvironmentMachineStateEntrySchema
>;
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
