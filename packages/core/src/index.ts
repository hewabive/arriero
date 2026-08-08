import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { ModelScanSettingsSchema } from "./models.js";
import { SourceRepositorySpecSchema } from "./sources.js";

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
export * from "./jobs.js";
export * from "./sources.js";
export * from "./build.js";
export * from "./environments.js";
export * from "./update.js";
export * from "./config-git.js";
export * from "./arguments.js";
export * from "./system.js";
export * from "./prerequisites.js";
export * from "./fleet.js";
export * from "./public-status.js";
export * from "./models.js";
export * from "./presets.js";

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
