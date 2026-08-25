import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { stripLegacyConfigTimestamps } from "./config-git.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { HfDownloadSettingsSchema } from "./hf.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { ModelScanSettingsSchema } from "./models.js";
import { PackageRegistriesSettingsSchema } from "./registries.js";
import { SourceRepositorySpecSchema } from "./sources.js";

const BUILD_HOST_FACT_KEYS = ["native", "parallelJobs"] as const;

function stripBuildHostFacts(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (BUILD_HOST_FACT_KEYS.every((key) => !(key in record))) {
    return value;
  }
  const rest = { ...record };
  for (const key of BUILD_HOST_FACT_KEYS) {
    delete rest[key];
  }
  return rest;
}

export const AppSettingsFileSchema = z
  .object({
    modelScan: ModelScanSettingsSchema.catchall(z.unknown()).optional(),
    sourceRepositories: z
      .array(
        z.preprocess(
          stripLegacyConfigTimestamps,
          SourceRepositorySpecSchema.catchall(z.unknown()),
        ),
      )
      .optional(),
    llamaSource: z
      .preprocess(
        stripLegacyConfigTimestamps,
        LlamaSourceSettingsSchema.catchall(z.unknown()),
      )
      .optional(),
    build: z
      .preprocess(
        stripBuildHostFacts,
        BuildSettingsSchema.omit({
          repoPath: true,
          native: true,
          parallelJobs: true,
        }).catchall(z.unknown()),
      )
      .optional(),
    environments: EnvironmentRepositorySettingsSchema.catchall(
      z.unknown(),
    ).optional(),
    registries: PackageRegistriesSettingsSchema.catchall(
      z.unknown(),
    ).optional(),
    downloads: HfDownloadSettingsSchema.catchall(z.unknown()).optional(),
  })
  .catchall(z.unknown())
  .default({});

export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;
