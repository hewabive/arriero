import { z } from "zod";

import { HfRepoIdSchema } from "./hf.js";

export const ModelRequirementSchema = z
  .object({
    id: z.string().min(1),
    repoId: HfRepoIdSchema,
    revision: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(2_000),
    destDir: z.string().min(1).nullable().default(null),
  })
  .catchall(z.unknown());

export const ModelRequirementCreateSchema = z.object({
  repoId: HfRepoIdSchema,
  revision: z.string().min(1).default("main"),
  paths: z.array(z.string().min(1)).min(1).max(2_000),
  destDir: z.string().min(1).nullable().default(null),
});

export const ModelRequirementStateSchema = z.enum([
  "satisfied",
  "partial",
  "missing",
]);

export const ModelRequirementStatusSchema = z.object({
  requirement: ModelRequirementSchema,
  state: ModelRequirementStateSchema,
  matchedDir: z.string().nullable(),
  missingPaths: z.array(z.string()),
  revisionMatch: z.boolean().nullable(),
});

export function isHfCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export type ModelRequirement = z.infer<typeof ModelRequirementSchema>;
export type ModelRequirementCreate = z.infer<
  typeof ModelRequirementCreateSchema
>;
export type ModelRequirementState = z.infer<typeof ModelRequirementStateSchema>;
export type ModelRequirementStatus = z.infer<
  typeof ModelRequirementStatusSchema
>;
