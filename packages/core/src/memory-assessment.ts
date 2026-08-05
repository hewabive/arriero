import { z } from "zod";

export const MemoryAssessmentStatusSchema = z.enum([
  "not-assessed",
  "update-required",
  "analytical",
  "measured",
  "verified",
  "mismatch",
]);

export const MemoryAssessmentEvidenceSchema = z.enum([
  "analytical",
  "measured",
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

export const MemoryAssessmentValidationSourceSchema = z.enum([
  "none",
  "log-buffers",
  "log-projection",
  "process-telemetry",
]);

export const MemoryPoolIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const InstanceMemoryDrawSchema = z.object({
  poolId: MemoryPoolIdSchema,
  bytes: z.number().int().nonnegative(),
});

export const MemoryAssessmentBaselineSchema = z.object({
  capturedAt: z.string(),
  deviceBytes: z.number().int().nonnegative(),
  hostBytes: z.number().int().nonnegative(),
  mmapBytes: z.number().int().nonnegative(),
  draws: z.array(InstanceMemoryDrawSchema),
});

export const MemoryAssessmentSummarySchema = z.object({
  status: MemoryAssessmentStatusSchema,
  reason: z.string(),
  reasons: z.array(z.string()).default([]),
  recommendation: z.string().nullable().default(null),
  assessedAt: z.string().nullable().default(null),
  evidence: MemoryAssessmentEvidenceSchema.nullable().default(null),
  estimatorId: z.string().nullable().default(null),
  estimatorVersion: z.number().int().nullable().default(null),
  confidence: z.enum(["high", "medium", "low"]).nullable().default(null),
  reservationStatus: MemoryAssessmentReservationStatusSchema,
  validationSource: MemoryAssessmentValidationSourceSchema,
  deltas: z.array(MemoryAssessmentDeltaSchema).default([]),
  baseline: MemoryAssessmentBaselineSchema.nullable().default(null),
  reportAvailable: z.boolean().default(false),
});

export const MemoryAssessmentBindRequestSchema = z.object({
  assessmentId: z.string().min(1),
});

export type MemoryAssessmentStatus = z.infer<
  typeof MemoryAssessmentStatusSchema
>;
export type MemoryAssessmentEvidence = z.infer<
  typeof MemoryAssessmentEvidenceSchema
>;
export type MemoryAssessmentDelta = z.infer<typeof MemoryAssessmentDeltaSchema>;
export type InstanceMemoryDraw = z.infer<typeof InstanceMemoryDrawSchema>;
export type MemoryAssessmentBaseline = z.infer<
  typeof MemoryAssessmentBaselineSchema
>;
export type MemoryAssessmentSummary = z.infer<
  typeof MemoryAssessmentSummarySchema
>;
