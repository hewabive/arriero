import { z } from "zod";

export const MachineBuildFactsSchema = z
  .object({
    native: z.boolean().nullable().default(null),
    parallelJobs: z.number().int().positive().max(256).nullable().default(null),
  })
  .catchall(z.unknown());

export const MachineLocalStateSchema = z
  .object({
    selfNodeId: z.string().min(1).nullable().default(null),
    build: MachineBuildFactsSchema.default({
      native: null,
      parallelJobs: null,
    }),
  })
  .catchall(z.unknown());

export type MachineBuildFacts = z.infer<typeof MachineBuildFactsSchema>;
export type MachineLocalState = z.infer<typeof MachineLocalStateSchema>;
