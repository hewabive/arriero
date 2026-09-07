import { z } from "zod";

export const FileVerificationProgressSchema = z.object({
  path: z.string(),
  processedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  bytesPerSecond: z.number().nonnegative().nullable(),
});
export type FileVerificationProgress = z.infer<
  typeof FileVerificationProgressSchema
>;
