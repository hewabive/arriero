import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { ModelScanSettingsSchema } from "./models.js";
import { SourceRepositorySpecSchema } from "./sources.js";

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
