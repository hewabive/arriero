import { z } from "zod";

export const MachineLocalStateSchema = z
  .object({
    selfNodeId: z.string().min(1).nullable().default(null),
  })
  .catchall(z.unknown());

export type MachineLocalState = z.infer<typeof MachineLocalStateSchema>;
