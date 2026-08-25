import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { storedConfigSchema, stripKeys } from "./config-git.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { HfDownloadSettingsSchema } from "./hf.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { LogRetentionSettingsSchema } from "./logs.js";
import { ModelScanSettingsSchema } from "./models.js";
import { PackageRegistriesSettingsSchema } from "./registries.js";
import { SourceRepositorySpecSchema } from "./sources.js";

export const BUILD_HOST_FACT_KEYS = ["native", "parallelJobs"] as const;

function stripBuildHostFacts(value: unknown): unknown {
  return stripKeys(value, BUILD_HOST_FACT_KEYS);
}

export const AppSettingsFileSchema = z
  .object({
    modelScan: ModelScanSettingsSchema.catchall(z.unknown()).optional(),
    sourceRepositories: z
      .array(storedConfigSchema(SourceRepositorySpecSchema))
      .optional(),
    llamaSource: storedConfigSchema(LlamaSourceSettingsSchema).optional(),
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
    logs: LogRetentionSettingsSchema.catchall(z.unknown()).optional(),
  })
  .catchall(z.unknown())
  .default({});

export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;
