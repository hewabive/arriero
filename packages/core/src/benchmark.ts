import { z } from "zod";

import {
  InstanceArgsSchema,
  InstanceEnvSchema,
  InstanceKindSchema,
  InstanceNumaSchema,
  RpcWorkerRefSchema,
} from "./instance.js";
import { BackgroundJobStatusSchema } from "./jobs.js";
import { WORKLOAD_DATASET_ID_PATTERN } from "./workload.js";

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

export const BenchmarkPromptMetaSchema = BenchmarkPromptWithSourceSchema.omit({
  messages: true,
});

export const BenchmarkPromptCreateSchema = BenchmarkPromptSchema.partial({
  id: true,
});

export const BenchmarkPromptUpdateSchema = BenchmarkPromptSchema.omit({
  id: true,
}).partial();

export const BenchmarkTargetSchema = z.object({
  kind: z.literal("instance"),
  instanceName: z.string().min(1),
});

export const BenchmarkSyntheticModeSchema = z.enum([
  "sequential",
  "parallel",
  "sustained",
]);

export const BenchmarkModeSchema = z.enum([
  ...BenchmarkSyntheticModeSchema.options,
  "replay",
]);

export const BenchmarkSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().optional(),
});

export const BenchmarkCompositionEntrySchema = z.object({
  promptId: z.string().min(1),
  count: z.number().int().min(1).max(64),
});

export const BENCHMARK_SYNTHETIC_DEFAULT_REQUEST_TIMEOUT_MS = 300000;

export function benchmarkClientCount(
  composition: readonly BenchmarkCompositionEntry[],
): number {
  return composition.reduce((sum, entry) => sum + entry.count, 0);
}

export const BenchmarkSyntheticScenarioSchema = z
  .object({
    target: BenchmarkTargetSchema,
    mode: BenchmarkSyntheticModeSchema,
    composition: z.array(BenchmarkCompositionEntrySchema).min(1).max(32),
    repetitions: z.number().int().min(1).max(20).default(1),
    totalRequests: z.number().int().min(1).max(100000).optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .default(BENCHMARK_SYNTHETIC_DEFAULT_REQUEST_TIMEOUT_MS),
    warmup: z.boolean().default(true),
    cacheBust: z.boolean().default(true),
    sampling: BenchmarkSamplingSchema.optional(),
    maxTokensOverride: z.number().int().min(1).max(32768).optional(),
    label: z.string().max(120).optional(),
  })
  .superRefine((scenario, context) => {
    if (scenario.mode !== "sustained") return;
    const clients = benchmarkClientCount(scenario.composition);
    if (
      scenario.totalRequests === undefined ||
      scenario.totalRequests < clients
    ) {
      context.addIssue({
        code: "custom",
        path: ["totalRequests"],
        message: `Sustained load needs a total request count of at least ${clients}`,
      });
    }
    if (scenario.repetitions !== 1) {
      context.addIssue({
        code: "custom",
        path: ["repetitions"],
        message:
          "Sustained load uses a total request count instead of repetitions",
      });
    }
  });

const ConcurrencyCapSchema = z.number().int().min(1).max(256).nullable();

export const BenchmarkReplayArrivalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recorded") }),
  z.object({
    kind: z.literal("together"),
    concurrencyCap: ConcurrencyCapSchema.default(null),
  }),
  z.object({
    kind: z.literal("interval"),
    intervalMs: z.number().int().min(0).max(3600000),
    concurrencyCap: ConcurrencyCapSchema.default(null),
  }),
]);

export const BenchmarkReplayThinkTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recorded") }),
  z.object({ kind: z.literal("scaled"), factor: z.number().min(0).max(100) }),
  z.object({
    kind: z.literal("capped"),
    maxMs: z.number().int().min(0).max(86400000),
  }),
  z.object({ kind: z.literal("none") }),
]);

export const BenchmarkReplayPrimingSchema = z.enum(["recorded", "all", "none"]);

export const BENCHMARK_REPLAY_DEFAULT_OUTPUT_CEILING = 8192;
export const BENCHMARK_REPLAY_DEFAULT_REQUEST_TIMEOUT_MS = 600000;

export const BenchmarkReplayScenarioSchema = z.object({
  target: BenchmarkTargetSchema,
  mode: z.literal("replay"),
  datasetId: z.string().regex(WORKLOAD_DATASET_ID_PATTERN),
  arrival: BenchmarkReplayArrivalSchema.default({ kind: "recorded" }),
  thinkTime: BenchmarkReplayThinkTimeSchema.default({ kind: "recorded" }),
  idleSkipping: z.boolean().default(true),
  priming: BenchmarkReplayPrimingSchema.default("recorded"),
  outputCeiling: z
    .number()
    .int()
    .min(1)
    .max(262144)
    .default(BENCHMARK_REPLAY_DEFAULT_OUTPUT_CEILING),
  imitateClientAborts: z.boolean().default(false),
  requestTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(BENCHMARK_REPLAY_DEFAULT_REQUEST_TIMEOUT_MS),
  warmup: z.boolean().default(true),
  sampling: BenchmarkSamplingSchema.optional(),
  label: z.string().max(120).optional(),
});

export const BenchmarkScenarioSchema = z.discriminatedUnion("mode", [
  BenchmarkSyntheticScenarioSchema,
  BenchmarkReplayScenarioSchema,
]);

export const BenchmarkCacheFlushMethodSchema = z.enum([
  "slot-erase",
  "model-reload",
  "reset-prefix-cache",
  "flush-cache",
  "restart",
]);

export const BenchmarkFlushVerificationSchema = z.enum([
  "passed",
  "failed",
  "unverified",
]);

export const BenchmarkReplaySnapshotSchema = z.object({
  datasetId: z.string(),
  datasetName: z.string(),
  preparedBodyHash: z.string(),
  segmentCount: z.number().int(),
  recordCount: z.number().int(),
  primedSegmentCount: z.number().int(),
  contextTokens: z.number().nullable(),
  reservedInstances: z.array(z.string()),
  flush: z
    .object({
      method: BenchmarkCacheFlushMethodSchema,
      detail: z.string(),
      verification: BenchmarkFlushVerificationSchema.nullable(),
      promptTokens: z.number().nullable(),
      cachedPromptTokens: z.number().nullable(),
    })
    .nullable(),
});

export const BenchmarkTargetSnapshotSchema = z.object({
  instanceName: z.string(),
  engineKind: InstanceKindSchema,
  baseUrl: z.string(),
  model: z.string().nullable(),
  binaryPath: z.string().nullable(),
  args: InstanceArgsSchema,
  env: InstanceEnvSchema.default({}),
  numa: InstanceNumaSchema.nullable().default(null),
  rpcWorkers: z.array(RpcWorkerRefSchema).default([]),
  launchCliArgs: z.array(z.string()).nullable().default(null),
  buildInfo: z.string().nullable().default(null),
  replay: BenchmarkReplaySnapshotSchema.optional(),
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
  endedMs: z.number().nullable().default(null),
  timedOut: z.boolean().default(false),
  maxChunkGapMs: z.number().nullable().default(null),
  chunkCount: z.number().int(),
  promptTokens: z.number().nullable(),
  cachedPromptTokens: z.number().nullable().default(null),
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
export const BENCHMARK_FAST_RATE_MIN_TOKENS = 32;
export const BENCHMARK_CLASS_FAST_MIN_WALL_MS = 100;
export const BENCHMARK_BASELINE_FAST_MIN_WALL_MS = 150;

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

const BenchmarkLatencyPercentilesSchema = z.object({
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
});

const BenchmarkLoadGroupSchema = z.object({
  promptId: z.string(),
  requestCount: z.number().int(),
  failedRequestCount: z.number().int(),
  timeToFirstTokenP95Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
  maxChunkGapMs: z.number().nullable(),
});

export const BenchmarkLoadSummarySchema = z.object({
  successfulRequestCount: z.number().int(),
  timedOutRequestCount: z.number().int(),
  canceledRequestCount: z.number().int(),
  requestsPerSecond: z.number().nullable(),
  outputTokensPerSecond: z.number().nullable(),
  timeToFirstToken: BenchmarkLatencyPercentilesSchema,
  latency: BenchmarkLatencyPercentilesSchema,
  maxChunkGapMs: z.number().nullable(),
  groups: z.array(BenchmarkLoadGroupSchema),
});

export const BenchmarkLoadBucketSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  outputTokens: z.number().nullable(),
  completedRequests: z.number().int(),
  failedRequests: z.number().int(),
  averageActiveRequests: z.number(),
  averageWaitingRequests: z.number(),
});

export const BenchmarkReplaySegmentResultSchema = z.object({
  segmentIndex: z.number().int(),
  sessionId: z.string(),
  windowIndex: z.number().int(),
  primed: z.boolean(),
  requestCount: z.number().int(),
  failedRequestCount: z.number().int(),
  promptTokens: z.number().nullable(),
  cachedPromptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  timeToFirstTokenP50Ms: z.number().nullable(),
  timeToFirstTokenP95Ms: z.number().nullable(),
  decodeTokensPerSecond: z.number().nullable(),
  acceptanceRate: z.number().nullable(),
  wallMs: z.number().nullable(),
});

export const BenchmarkReplayFidelitySchema = z.object({
  comparedRequestCount: z.number().int(),
  uncomparedRequestCount: z.number().int(),
  recordedPromptTokens: z.number(),
  recordedCachedPromptTokens: z.number(),
  replayedPromptTokens: z.number(),
  replayedCachedPromptTokens: z.number(),
  responseReuseTokens: z.number(),
});

export const BenchmarkReplaySummarySchema = z.object({
  segments: z.array(BenchmarkReplaySegmentResultSchema),
  fidelity: BenchmarkReplayFidelitySchema.nullable(),
});

export const BenchmarkReplayFidelityRecordSchema = z.object({
  requestId: z.string(),
  segmentIndex: z.number().int(),
  recordIndex: z.number().int(),
  traceId: z.string(),
  recordedPromptTokens: z.number().nullable(),
  recordedCachedPromptTokens: z.number().nullable(),
  replayedPromptTokens: z.number().nullable(),
  replayedCachedPromptTokens: z.number().nullable(),
  responseReuseTokens: z.number().nullable(),
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
  load: BenchmarkLoadSummarySchema.optional(),
  replay: BenchmarkReplaySummarySchema.optional(),
});

export const BenchmarkRunResultSchema = z.object({
  requests: z.array(BenchmarkRequestResultSchema),
  segments: z.array(BenchmarkSegmentSchema),
  loadTimeline: z.array(BenchmarkLoadBucketSchema).optional(),
  fidelity: z.array(BenchmarkReplayFidelityRecordSchema).optional(),
});

export const BenchmarkRunPhaseSchema = z.enum([
  "prepare",
  "flush",
  "warmup",
  "priming",
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
  message: z.string().optional(),
});

export const BenchmarkReservationPreviewSchema = z.object({
  instanceNames: z.array(z.string()),
  targetNames: z.array(z.string()),
  drawsDeclared: z.boolean(),
});

export const BenchmarkContextFitSegmentSchema = z.object({
  sessionId: z.string(),
  traceId: z.string(),
  promptTokens: z.number().nullable(),
  fits: z.boolean().nullable(),
});

export const BenchmarkContextFitSchema = z.object({
  contextTokens: z.number().nullable(),
  outputCeiling: z.number().int(),
  segments: z.array(BenchmarkContextFitSegmentSchema),
  warnings: z.array(z.string()),
});

export type BenchmarkMessage = z.infer<typeof BenchmarkMessageSchema>;
export type BenchmarkPrefillClass = z.infer<typeof BenchmarkPrefillClassSchema>;
export type BenchmarkPrompt = z.infer<typeof BenchmarkPromptSchema>;
export type BenchmarkPromptSource = z.infer<typeof BenchmarkPromptSourceSchema>;
export type BenchmarkPromptWithSource = z.infer<
  typeof BenchmarkPromptWithSourceSchema
>;
export type BenchmarkPromptMeta = z.infer<typeof BenchmarkPromptMetaSchema>;
export type BenchmarkPromptCreate = z.infer<typeof BenchmarkPromptCreateSchema>;
export type BenchmarkPromptUpdate = z.infer<typeof BenchmarkPromptUpdateSchema>;
export type BenchmarkTarget = z.infer<typeof BenchmarkTargetSchema>;
export type BenchmarkMode = z.infer<typeof BenchmarkModeSchema>;
export type BenchmarkSyntheticMode = z.infer<
  typeof BenchmarkSyntheticModeSchema
>;
export type BenchmarkSampling = z.infer<typeof BenchmarkSamplingSchema>;
export type BenchmarkCompositionEntry = z.infer<
  typeof BenchmarkCompositionEntrySchema
>;
export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>;
export type BenchmarkScenarioInput = z.input<typeof BenchmarkScenarioSchema>;
export type BenchmarkSyntheticScenario = z.infer<
  typeof BenchmarkSyntheticScenarioSchema
>;
export type BenchmarkReplayScenario = z.infer<
  typeof BenchmarkReplayScenarioSchema
>;
export type BenchmarkReplayScenarioInput = z.input<
  typeof BenchmarkReplayScenarioSchema
>;
export type BenchmarkReplayArrival = z.infer<
  typeof BenchmarkReplayArrivalSchema
>;
export type BenchmarkReplayThinkTime = z.infer<
  typeof BenchmarkReplayThinkTimeSchema
>;
export type BenchmarkReplayPriming = z.infer<
  typeof BenchmarkReplayPrimingSchema
>;
export type BenchmarkCacheFlushMethod = z.infer<
  typeof BenchmarkCacheFlushMethodSchema
>;
export type BenchmarkFlushVerification = z.infer<
  typeof BenchmarkFlushVerificationSchema
>;
export type BenchmarkReplaySnapshot = z.infer<
  typeof BenchmarkReplaySnapshotSchema
>;
export type BenchmarkReplaySegmentResult = z.infer<
  typeof BenchmarkReplaySegmentResultSchema
>;
export type BenchmarkReplayFidelity = z.infer<
  typeof BenchmarkReplayFidelitySchema
>;
export type BenchmarkReplaySummary = z.infer<
  typeof BenchmarkReplaySummarySchema
>;
export type BenchmarkReplayFidelityRecord = z.infer<
  typeof BenchmarkReplayFidelityRecordSchema
>;
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
export type BenchmarkLoadSummary = z.infer<typeof BenchmarkLoadSummarySchema>;
export type BenchmarkLoadBucket = z.infer<typeof BenchmarkLoadBucketSchema>;
export type BenchmarkRunSummary = z.infer<typeof BenchmarkRunSummarySchema>;
export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;
export type BenchmarkRunPhase = z.infer<typeof BenchmarkRunPhaseSchema>;
export type BenchmarkRunProgress = z.infer<typeof BenchmarkRunProgressSchema>;
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;
export type BenchmarkStreamEventKind = z.infer<
  typeof BenchmarkStreamEventKindSchema
>;
export type BenchmarkStreamEvent = z.infer<typeof BenchmarkStreamEventSchema>;
export type BenchmarkReservationPreview = z.infer<
  typeof BenchmarkReservationPreviewSchema
>;
export type BenchmarkContextFit = z.infer<typeof BenchmarkContextFitSchema>;

export function benchmarkRequestEndMs(
  request: Pick<BenchmarkRequestResult, "submitMs" | "doneMs" | "endedMs">,
): number {
  return request.endedMs ?? request.doneMs ?? request.submitMs;
}

export function isBenchmarkRateSupported(
  tokens: number,
  wallMs: number,
): boolean {
  if (wallMs >= BENCHMARK_CLASS_MIN_WALL_MS) return true;
  return (
    tokens >= BENCHMARK_FAST_RATE_MIN_TOKENS &&
    wallMs >= BENCHMARK_CLASS_FAST_MIN_WALL_MS
  );
}

export function isBenchmarkClassSupported(
  entry: BenchmarkSegmentClass,
): boolean {
  return (
    entry.decodeCount > 0 &&
    isBenchmarkRateSupported(entry.decodeTokens, entry.wallMs)
  );
}

function qualifiesAsBaseline(entry: BenchmarkSegmentClass): boolean {
  if (
    entry.wallMs >= BENCHMARK_BASELINE_MIN_WALL_MS &&
    entry.decodeTokens >= BENCHMARK_BASELINE_MIN_TOKENS
  ) {
    return true;
  }
  return (
    entry.wallMs >= BENCHMARK_BASELINE_FAST_MIN_WALL_MS &&
    entry.decodeTokens >= BENCHMARK_FAST_RATE_MIN_TOKENS
  );
}

export function soloDecodeBaseline(
  classes: readonly BenchmarkSegmentClass[],
): number | null {
  const solo = classes.find(
    (entry) =>
      entry.prefillCount === 0 &&
      entry.decodeCount === 1 &&
      qualifiesAsBaseline(entry),
  );
  return solo?.perRequestDecodeTokensPerSecond ?? null;
}
