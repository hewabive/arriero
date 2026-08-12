import { z } from "zod";

import { BuildJobStepStatusSchema } from "./build.js";
import { BackgroundJobStatusSchema } from "./jobs.js";

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
