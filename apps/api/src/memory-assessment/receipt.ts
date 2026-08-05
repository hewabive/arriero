import {
  InstanceMemoryDrawSchema,
  MemoryAssessmentDeltaSchema,
  MemoryAssessmentValidationSourceSchema,
  MemoryEstimateSchema,
  type Instance,
} from "@arriero/core";
import { z } from "zod";

import { canonicalJsonDigest as digest } from "../utils/canonical-json.js";
import { sortedByKey } from "../utils/sort.js";

export const FileIdentitySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative().optional(),
});

export const FingerprintSchema = z.object({
  digest: z.string(),
  configDigest: z.string(),
  hardwareDigest: z.string(),
  binary: FileIdentitySchema.nullable(),
  runtimeFiles: z.array(FileIdentitySchema),
  artifacts: z.array(FileIdentitySchema),
  currentBinaryPath: z.string(),
});

export const ValidationSchema = z.object({
  source: MemoryAssessmentValidationSourceSchema.exclude(["none"]),
  observedAt: z.string(),
  runId: z.string().nullable().default(null),
  verdict: z.enum(["verified", "mismatch", "inconclusive"]),
  deltas: z.array(MemoryAssessmentDeltaSchema),
});

export const AnalyticalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  evidence: z.literal("analytical").default("analytical"),
  estimatorId: z.string().min(1),
  estimatorVersion: z.number().int(),
  createdAt: z.string(),
  fingerprint: FingerprintSchema,
  estimate: MemoryEstimateSchema,
  appliedDrawsDigest: z.string().nullable(),
  validation: ValidationSchema.nullable(),
});

export const MeasuredObservationSchema = z.object({
  capturedAt: z.string(),
  runId: z.string().nullable(),
  processIds: z.array(z.number().int().positive()),
  deviceBytes: z.number().int().nonnegative(),
  hostBytes: z.number().int().nonnegative(),
  mmapBytes: z.number().int().nonnegative(),
  draws: z.array(InstanceMemoryDrawSchema),
  notes: z.array(z.string()),
});

export const MeasuredReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  evidence: z.literal("measured"),
  baselineVersion: z.literal(1),
  createdAt: z.string(),
  fingerprint: FingerprintSchema,
  observation: MeasuredObservationSchema,
  previousBaseline: z
    .object({
      capturedAt: z.string(),
      deltas: z.array(MemoryAssessmentDeltaSchema),
    })
    .nullable(),
  proposedDrawsDigest: z.string(),
  validation: ValidationSchema.nullable(),
});

export const ReceiptSchema = z.union([
  MeasuredReceiptSchema,
  AnalyticalReceiptSchema,
]);

export type FileIdentity = z.infer<typeof FileIdentitySchema>;
export type MemoryAssessmentFingerprint = z.infer<typeof FingerprintSchema>;
export type MemoryAssessmentValidation = z.infer<typeof ValidationSchema>;
export type AnalyticalReceipt = z.infer<typeof AnalyticalReceiptSchema>;
export type MeasuredObservation = z.infer<typeof MeasuredObservationSchema>;
export type MeasuredReceipt = z.infer<typeof MeasuredReceiptSchema>;
export type MemoryAssessmentReceipt = z.infer<typeof ReceiptSchema>;

export function parseStoredReceipt(
  receipt: unknown,
): MemoryAssessmentReceipt | null {
  const parsed = ReceiptSchema.safeParse(receipt);
  return parsed.success ? parsed.data : null;
}

export function exceedsTolerance(delta: {
  deltaBytes: number;
  toleranceBytes: number;
}): boolean {
  return Math.abs(delta.deltaBytes) > delta.toleranceBytes;
}

export function drawsDigest(draws: Instance["memory"]): string {
  return digest(
    sortedByKey(
      draws.map((draw) => ({ poolId: draw.poolId, bytes: draw.bytes })),
      (draw) => draw.poolId,
    ),
  );
}
