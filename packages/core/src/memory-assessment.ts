import { z } from "zod";

export const MemoryAssessmentStatusSchema = z.enum([
  "not-assessed",
  "update-required",
  "analytical",
  "verified",
  "mismatch",
]);

export const MemoryAssessmentReservationStatusSchema = z.enum([
  "not-applied",
  "applied",
  "modified",
]);

export const MemoryAssessmentDeltaSchema = z.object({
  scope: z.enum(["gpu", "host"]),
  expectedBytes: z.number().int().nonnegative(),
  observedBytes: z.number().int().nonnegative(),
  deltaBytes: z.number().int(),
  toleranceBytes: z.number().int().nonnegative(),
});

export const MemoryAssessmentSummarySchema = z.object({
  status: MemoryAssessmentStatusSchema,
  reason: z.string(),
  reasons: z.array(z.string()).default([]),
  recommendation: z.string().nullable().default(null),
  assessedAt: z.string().nullable().default(null),
  estimatorId: z.string().nullable().default(null),
  estimatorVersion: z.number().int().nullable().default(null),
  confidence: z.enum(["high", "medium", "low"]).nullable().default(null),
  reservationStatus: MemoryAssessmentReservationStatusSchema,
  validationSource: z.enum([
    "none",
    "log-buffers",
    "log-projection",
    "process-telemetry",
  ]),
  deltas: z.array(MemoryAssessmentDeltaSchema).default([]),
  reportAvailable: z.boolean().default(false),
});

export const MemoryAssessmentBindRequestSchema = z.object({
  assessmentId: z.string().min(1),
});

export type MemoryAssessmentStatus = z.infer<
  typeof MemoryAssessmentStatusSchema
>;
export type MemoryAssessmentDelta = z.infer<typeof MemoryAssessmentDeltaSchema>;
export type MemoryAssessmentSummary = z.infer<
  typeof MemoryAssessmentSummarySchema
>;
