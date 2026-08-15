import { z } from "zod";

import { InstanceArgsSchema, InstanceKindSchema } from "./instance.js";
import { BackgroundJobStatusSchema } from "./jobs.js";

export const BenchmarkMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

export const BenchmarkPrefillClassSchema = z.enum(["short", "long"]);

export const BENCHMARK_PROMPT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const BenchmarkPromptSchema = z.object({
  id: z.string().min(1).max(80).regex(BENCHMARK_PROMPT_ID_PATTERN),
  title: z.string().min(1).max(120),
  topic: z.string().min(1).max(40),
  language: z.string().min(2).max(16),
  prefillClass: BenchmarkPrefillClassSchema,
  maxTokens: z.number().int().min(1).max(32768),
  messages: z.array(BenchmarkMessageSchema).min(1),
});

export const BenchmarkPromptSourceSchema = z.enum(["builtin", "custom"]);

export const BenchmarkPromptWithSourceSchema = BenchmarkPromptSchema.extend({
  source: BenchmarkPromptSourceSchema,
});

export const BenchmarkPromptCreateSchema = BenchmarkPromptSchema.partial({
  id: true,
});

export const BenchmarkPromptUpdateSchema = BenchmarkPromptSchema.omit({
  id: true,
}).partial();

export const BenchmarkTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instance"),
    instanceName: z.string().min(1),
  }),
]);

export const BenchmarkModeSchema = z.enum(["sequential", "parallel"]);

export const BenchmarkSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().optional(),
});

export const BenchmarkCompositionEntrySchema = z.object({
  promptId: z.string().min(1),
  count: z.number().int().min(1).max(64),
});

export const BenchmarkScenarioSchema = z.object({
  target: BenchmarkTargetSchema,
  mode: BenchmarkModeSchema,
  composition: z.array(BenchmarkCompositionEntrySchema).min(1).max(32),
  repetitions: z.number().int().min(1).max(20).default(1),
  warmup: z.boolean().default(true),
  cacheBust: z.boolean().default(true),
  sampling: BenchmarkSamplingSchema.optional(),
  maxTokensOverride: z.number().int().min(1).max(32768).optional(),
  label: z.string().max(120).optional(),
});

export const BenchmarkTargetSnapshotSchema = z.object({
  instanceName: z.string(),
  engineKind: InstanceKindSchema,
  baseUrl: z.string(),
  model: z.string().nullable(),
  binaryPath: z.string().nullable(),
  args: InstanceArgsSchema,
});

export const BenchmarkServerTimingsSchema = z.object({
  promptN: z.number().nullable(),
  promptMs: z.number().nullable(),
  predictedN: z.number().nullable(),
  predictedMs: z.number().nullable(),
  draftN: z.number().nullable(),
  draftNAccepted: z.number().nullable(),
});

export const BenchmarkRequestResultSchema = z.object({
  requestId: z.string(),
  promptId: z.string(),
  topic: z.string(),
  language: z.string(),
  repetition: z.number().int().min(0),
  submitMs: z.number(),
  prefillStartMs: z.number().nullable(),
  firstTokenMs: z.number().nullable(),
  doneMs: z.number().nullable(),
  chunkCount: z.number().int(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  clientDecodeTokensPerSecond: z.number().nullable(),
  serverTimings: BenchmarkServerTimingsSchema.nullable(),
  acceptanceRate: z.number().nullable(),
  finishReason: z.string().nullable(),
  error: z.string().nullable(),
});

export const BenchmarkSegmentSchema = z.object({
  repetition: z.number().int().min(0),
  startMs: z.number(),
  endMs: z.number(),
  prefillCount: z.number().int(),
  decodeCount: z.number().int(),
  decodeTokens: z.number(),
  decodeTokensPerSecond: z.number().nullable(),
});

export const BenchmarkSegmentClassSchema = z.object({
  prefillCount: z.number().int(),
  decodeCount: z.number().int(),
  wallMs: z.number(),
  wallShare: z.number(),
  decodeTokens: z.number(),
  decodeTokensPerSecond: z.number().nullable(),
  perRequestDecodeTokensPerSecond: z.number().nullable(),
});

export const BenchmarkTopicSummarySchema = z.object({
  topic: z.string(),
  language: z.string(),
  requestCount: z.number().int(),
  soloDecodeTokensPerSecond: z.number().nullable(),
  contendedDecodeTokensPerSecond: z.number().nullable(),
  acceptanceRate: z.number().nullable(),
  averageTimeToFirstTokenMs: z.number().nullable(),
});

export const BENCHMARK_CLASS_MIN_WALL_MS = 200;
export const BENCHMARK_BASELINE_MIN_WALL_MS = 500;
export const BENCHMARK_BASELINE_MIN_TOKENS = 8;

export const BenchmarkHeadlineSchema = z.object({
  decodeTokensPerSecond: z.number().nullable(),
  perRequestDecodeTokensPerSecond: z.number().nullable(),
  soloDecodeTokensPerSecond: z.number().nullable(),
  prefillTokensPerSecond: z.number().nullable(),
  totalPromptTokens: z.number(),
  timeToFirstTokenP50Ms: z.number().nullable(),
  timeToFirstTokenP95Ms: z.number().nullable(),
  peakConcurrentDecode: z.number().int(),
});

export const BenchmarkRunSummarySchema = z.object({
  requestCount: z.number().int(),
  failedRequestCount: z.number().int(),
  totalCompletionTokens: z.number(),
  wallMs: z.number(),
  acceptanceRate: z.number().nullable(),
  headline: BenchmarkHeadlineSchema.nullable().default(null),
  topics: z.array(BenchmarkTopicSummarySchema),
  segmentClasses: z.array(BenchmarkSegmentClassSchema),
});

export const BenchmarkRunResultSchema = z.object({
  requests: z.array(BenchmarkRequestResultSchema),
  segments: z.array(BenchmarkSegmentSchema),
  segmentClasses: z.array(BenchmarkSegmentClassSchema),
  topics: z.array(BenchmarkTopicSummarySchema),
});

export const BenchmarkRunPhaseSchema = z.enum([
  "prepare",
  "warmup",
  "measure",
  "finalize",
]);

export const BenchmarkRunProgressSchema = z.object({
  phase: BenchmarkRunPhaseSchema,
  completedRequests: z.number().int(),
  totalRequests: z.number().int(),
  activeRequests: z.number().int(),
  repetition: z.number().int(),
});

export const BenchmarkRunSchema = z.object({
  id: z.string(),
  status: BackgroundJobStatusSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  label: z.string().nullable(),
  scenario: BenchmarkScenarioSchema,
  snapshot: BenchmarkTargetSnapshotSchema.nullable(),
  warnings: z.array(z.string()),
  summary: BenchmarkRunSummarySchema.nullable(),
  error: z.string().nullable(),
  progress: BenchmarkRunProgressSchema.nullable(),
});

export const BenchmarkStreamEventKindSchema = z.enum([
  "submit",
  "first-token",
  "chunk",
  "done",
  "error",
]);

export const BenchmarkStreamEventSchema = z.object({
  requestId: z.string(),
  tMs: z.number(),
  kind: BenchmarkStreamEventKindSchema,
  chars: z.number().int().optional(),
  message: z.string().optional(),
});

export type BenchmarkMessage = z.infer<typeof BenchmarkMessageSchema>;
export type BenchmarkPrefillClass = z.infer<typeof BenchmarkPrefillClassSchema>;
export type BenchmarkPrompt = z.infer<typeof BenchmarkPromptSchema>;
export type BenchmarkPromptSource = z.infer<typeof BenchmarkPromptSourceSchema>;
export type BenchmarkPromptWithSource = z.infer<
  typeof BenchmarkPromptWithSourceSchema
>;
export type BenchmarkPromptCreate = z.infer<typeof BenchmarkPromptCreateSchema>;
export type BenchmarkPromptUpdate = z.infer<typeof BenchmarkPromptUpdateSchema>;
export type BenchmarkTarget = z.infer<typeof BenchmarkTargetSchema>;
export type BenchmarkMode = z.infer<typeof BenchmarkModeSchema>;
export type BenchmarkSampling = z.infer<typeof BenchmarkSamplingSchema>;
export type BenchmarkCompositionEntry = z.infer<
  typeof BenchmarkCompositionEntrySchema
>;
export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>;
export type BenchmarkScenarioInput = z.input<typeof BenchmarkScenarioSchema>;
export type BenchmarkTargetSnapshot = z.infer<
  typeof BenchmarkTargetSnapshotSchema
>;
export type BenchmarkServerTimings = z.infer<
  typeof BenchmarkServerTimingsSchema
>;
export type BenchmarkRequestResult = z.infer<
  typeof BenchmarkRequestResultSchema
>;
export type BenchmarkSegment = z.infer<typeof BenchmarkSegmentSchema>;
export type BenchmarkSegmentClass = z.infer<typeof BenchmarkSegmentClassSchema>;
export type BenchmarkTopicSummary = z.infer<typeof BenchmarkTopicSummarySchema>;
export type BenchmarkHeadline = z.infer<typeof BenchmarkHeadlineSchema>;
export type BenchmarkRunSummary = z.infer<typeof BenchmarkRunSummarySchema>;
export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;
export type BenchmarkRunPhase = z.infer<typeof BenchmarkRunPhaseSchema>;
export type BenchmarkRunProgress = z.infer<typeof BenchmarkRunProgressSchema>;
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;
export type BenchmarkStreamEventKind = z.infer<
  typeof BenchmarkStreamEventKindSchema
>;
export type BenchmarkStreamEvent = z.infer<typeof BenchmarkStreamEventSchema>;

export function isBenchmarkClassSupported(
  entry: BenchmarkSegmentClass,
): boolean {
  return entry.decodeCount > 0 && entry.wallMs >= BENCHMARK_CLASS_MIN_WALL_MS;
}

export function soloDecodeBaseline(
  classes: readonly BenchmarkSegmentClass[],
): number | null {
  const solo = classes.find(
    (entry) =>
      entry.prefillCount === 0 &&
      entry.decodeCount === 1 &&
      entry.wallMs >= BENCHMARK_BASELINE_MIN_WALL_MS &&
      entry.decodeTokens >= BENCHMARK_BASELINE_MIN_TOKENS,
  );
  return solo?.perRequestDecodeTokensPerSecond ?? null;
}
