import { z } from "zod";

export const BackgroundJobStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;
