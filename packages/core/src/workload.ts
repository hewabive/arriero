import { z } from "zod";

import { BackgroundJobStatusSchema } from "./jobs.js";

export const WorkloadOutcomeSchema = z.enum([
  "success",
  "client-abort",
  "not-served",
  "error",
]);

export const WorkloadReplayableOutcomeSchema = WorkloadOutcomeSchema.extract([
  "success",
  "client-abort",
]);

export const WorkloadRecordIssueSchema = z.enum([
  "capture-after-rewrite",
  "unsupported-operation",
  "stateful-request",
  "capture-unreadable",
  "body-not-object",
]);

const TokenCountSchema = z.number().int().min(0).nullable();

export const WorkloadTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be a timestamp",
  });

export const MAX_WORKLOAD_PROFILE_WINDOWS = 2000;

export const WorkloadRecordSchema = z.object({
  traceId: z.string(),
  at: z.string(),
  endAt: z.string(),
  durationMs: z.number().int().min(0),
  sourceId: z.string().nullable(),
  sourceName: z.string().nullable(),
  modelId: z.string(),
  targetId: z.string().nullable(),
  targetName: z.string().nullable(),
  protocol: z.enum(["openai", "anthropic"]),
  endpoint: z.string(),
  outcome: WorkloadOutcomeSchema,
  issue: WorkloadRecordIssueSchema.nullable(),
  capturePath: z.string().nullable(),
  messageCount: z.number().int().min(0).nullable(),
  sessionId: z.string(),
  parentTraceId: z.string().nullable(),
  sharedMessages: z.number().int().min(0).nullable(),
  clientSessionId: z.string().nullable(),
  promptTokens: TokenCountSchema,
  cacheReadTokens: TokenCountSchema,
  completionTokens: TokenCountSchema,
  ttftMs: z.number().int().min(0).nullable(),
  thinkTimeMs: z.number().int().min(0).nullable(),
  cacheLossTokens: TokenCountSchema,
  responseReuseTokens: TokenCountSchema,
});

export const WorkloadSessionSummarySchema = z.object({
  sessionId: z.string(),
  sourceId: z.string().nullable(),
  sourceName: z.string().nullable(),
  modelId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  records: z.number().int().min(0),
  replayable: z.number().int().min(0),
  errors: z.number().int().min(0),
  notServed: z.number().int().min(0),
  clientAborts: z.number().int().min(0),
  maxPromptTokens: TokenCountSchema,
  targetNames: z.array(z.string()),
});

export const WorkloadSessionDetailSchema = z.object({
  summary: WorkloadSessionSummarySchema,
  records: z.array(WorkloadRecordSchema),
});

const WorkloadScopeQuerySchema = z.object({
  from: WorkloadTimestampSchema.optional(),
  to: WorkloadTimestampSchema.optional(),
  sourceId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
});

export const WorkloadSessionListQuerySchema = WorkloadScopeQuerySchema.extend({
  beforeAt: z.string().optional(),
  beforeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const WorkloadProfileQuerySchema = WorkloadScopeQuerySchema.extend({
  windowMinutes: z.coerce.number().int().min(1).max(1440).default(15),
  stepMinutes: z.coerce.number().int().min(1).max(1440).default(5),
});

export const WorkloadLinkingQuerySchema = z.object({
  from: WorkloadTimestampSchema.optional(),
  to: WorkloadTimestampSchema.optional(),
});

export const WorkloadWindowRankSchema = z.enum(["typical", "peak"]);

export const WorkloadProfileWindowSchema = z.object({
  startAt: z.string(),
  endAt: z.string(),
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  notServed: z.number().int().min(0),
  activeSessions: z.number().int().min(0),
  meanInFlight: z.number().min(0),
  promptTokensP50: z.number().nullable(),
  promptTokensP90: z.number().nullable(),
  freshPrefillTokens: z.number().nullable(),
  cachedPromptTokens: z.number().nullable(),
  cachedShare: z.number().nullable(),
  completionTokensP50: z.number().nullable(),
  completionTokensP90: z.number().nullable(),
  cacheLossTokens: z.number().nullable(),
  responseReuseTokens: z.number().nullable(),
});

export const WorkloadProfileSchema = z.object({
  from: z.string(),
  to: z.string(),
  windowMinutes: z.number().int(),
  stepMinutes: z.number().int(),
  period: WorkloadProfileWindowSchema,
  windows: z.array(WorkloadProfileWindowSchema),
});

export const WorkloadRankedWindowSchema = WorkloadProfileWindowSchema.extend({
  score: z.number(),
});

export const WorkloadLinkingGroupSchema = z.object({
  sourceId: z.string().nullable(),
  sourceName: z.string().nullable(),
  modelId: z.string(),
  linkableRecords: z.number().int().min(0),
  linkedRecords: z.number().int().min(0),
  sessions: z.number().int().min(0),
  clientSessions: z.number().int().min(0),
  clientSessionPairs: z.number().int().min(0),
  clientSessionAgreeing: z.number().int().min(0),
});

export const WorkloadLinkingReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  groups: z.array(WorkloadLinkingGroupSchema),
});

export const WorkloadIndexStatusSchema = z.object({
  normalizationVersion: z.number().int().nullable(),
  records: z.number().int().min(0),
  oldestAt: z.string().nullable(),
  newestAt: z.string().nullable(),
  lastPassAt: z.string().nullable(),
  lastPassIndexed: z.number().int().min(0),
});

export const WORKLOAD_DATASET_FORMAT_VERSION = 1;

export const WorkloadTimeRangeSchema = z.object({
  from: WorkloadTimestampSchema,
  to: WorkloadTimestampSchema,
});

const StoredTimeRangeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const WorkloadDatasetSelectionSchema = z.object({
  windows: z.array(WorkloadTimeRangeSchema).min(1).max(64),
  sourceId: z.string().min(1).nullable().default(null),
  modelId: z.string().min(1).nullable().default(null),
  targetId: z.string().min(1).nullable().default(null),
});

export const WorkloadDatasetFreezeRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  selection: WorkloadDatasetSelectionSchema,
  population: WorkloadTimeRangeSchema.nullable().default(null),
});

export const WORKLOAD_DATASET_ID_PATTERN = /^[0-9a-f]{64}$/;

export const WorkloadContentHashSchema = z
  .string()
  .regex(WORKLOAD_DATASET_ID_PATTERN);

export const WorkloadDatasetBodySchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  messages: z.array(WorkloadContentHashSchema),
  tools: WorkloadContentHashSchema.nullable(),
  system: WorkloadContentHashSchema.nullable(),
});

export const WorkloadDatasetRecordSchema = z.object({
  traceId: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  endpoint: z.string(),
  routePath: z.string(),
  offsetMs: z.number().int().min(0),
  thinkTimeMs: z.number().int().min(0).nullable(),
  durationMs: z.number().int().min(0),
  outcome: WorkloadReplayableOutcomeSchema,
  targetName: z.string().nullable(),
  promptTokens: TokenCountSchema,
  cacheReadTokens: TokenCountSchema,
  completionTokens: TokenCountSchema,
  ttftMs: z.number().int().min(0).nullable(),
  body: WorkloadDatasetBodySchema,
});

export const WorkloadDatasetSegmentSchema = z.object({
  sessionId: z.string(),
  windowIndex: z.number().int().min(0),
  sourceName: z.string().nullable(),
  modelId: z.string(),
  priming: WorkloadDatasetRecordSchema.nullable(),
  primingEndedAt: z.string().nullable(),
  records: z.array(WorkloadDatasetRecordSchema).min(1),
});

export const WorkloadDatasetContentSchema = z.object({
  formatVersion: z.literal(WORKLOAD_DATASET_FORMAT_VERSION),
  normalizationVersion: z.number().int(),
  selection: z.object({
    windows: z.array(StoredTimeRangeSchema).min(1),
    sourceId: z.string().nullable(),
    sourceName: z.string().nullable(),
    modelId: z.string().nullable(),
    targetId: z.string().nullable(),
    targetName: z.string().nullable(),
  }),
  segments: z.array(WorkloadDatasetSegmentSchema).min(1),
});

export const WorkloadDatasetMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  arrieroVersion: z.string().nullable(),
  population: StoredTimeRangeSchema.nullable(),
  profile: WorkloadProfileWindowSchema.nullable(),
  populationProfile: WorkloadProfileWindowSchema.nullable(),
  warnings: z.array(z.string()),
});

export const WorkloadDatasetManifestSchema = z.object({
  id: WorkloadContentHashSchema,
  meta: WorkloadDatasetMetaSchema,
  content: WorkloadDatasetContentSchema,
});

export const WorkloadDatasetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  windows: z.array(StoredTimeRangeSchema),
  sourceName: z.string().nullable(),
  modelId: z.string().nullable(),
  segments: z.number().int().min(0),
  records: z.number().int().min(0),
  primedSegments: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

export const WorkloadSegmentSummarySchema = z.object({
  sessionId: z.string(),
  windowIndex: z.number().int().min(0),
  sourceName: z.string().nullable(),
  modelId: z.string(),
  records: z.number().int().min(0),
  primed: z.boolean(),
  firstAt: z.string(),
  lastEndAt: z.string(),
  maxPromptTokens: TokenCountSchema,
});

export const WorkloadDatasetDetailSchema = z.object({
  summary: WorkloadDatasetSummarySchema,
  meta: WorkloadDatasetMetaSchema,
  segments: z.array(WorkloadSegmentSummarySchema),
});

export const WorkloadSelectionPreviewSchema = z.object({
  segments: z.array(WorkloadSegmentSummarySchema),
  records: z.number().int().min(0),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const WorkloadFreezeJobSchema = z.object({
  id: z.string(),
  status: BackgroundJobStatusSchema,
  name: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  processedRecords: z.number().int().min(0),
  totalRecords: z.number().int().min(0),
  datasetId: z.string().nullable(),
  error: z.string().nullable(),
});

export const WorkloadDatasetImportResultSchema = z.object({
  id: z.string(),
  imported: z.boolean(),
});

export type WorkloadOutcome = z.infer<typeof WorkloadOutcomeSchema>;
export type WorkloadReplayableOutcome = z.infer<
  typeof WorkloadReplayableOutcomeSchema
>;
export type WorkloadRecordIssue = z.infer<typeof WorkloadRecordIssueSchema>;
export type WorkloadRecord = z.infer<typeof WorkloadRecordSchema>;
export type WorkloadSessionSummary = z.infer<
  typeof WorkloadSessionSummarySchema
>;
export type WorkloadSessionDetail = z.infer<typeof WorkloadSessionDetailSchema>;
export type WorkloadSessionListQuery = z.infer<
  typeof WorkloadSessionListQuerySchema
>;
export type WorkloadSessionListQueryInput = z.input<
  typeof WorkloadSessionListQuerySchema
>;
export type WorkloadProfileQuery = z.infer<typeof WorkloadProfileQuerySchema>;
export type WorkloadProfileQueryInput = z.input<
  typeof WorkloadProfileQuerySchema
>;
export type WorkloadWindowRank = z.infer<typeof WorkloadWindowRankSchema>;
export type WorkloadLinkingQueryInput = z.input<
  typeof WorkloadLinkingQuerySchema
>;
export type WorkloadProfileWindow = z.infer<typeof WorkloadProfileWindowSchema>;
export type WorkloadProfile = z.infer<typeof WorkloadProfileSchema>;
export type WorkloadRankedWindow = z.infer<typeof WorkloadRankedWindowSchema>;
export type WorkloadLinkingGroup = z.infer<typeof WorkloadLinkingGroupSchema>;
export type WorkloadLinkingReport = z.infer<typeof WorkloadLinkingReportSchema>;
export type WorkloadIndexStatus = z.infer<typeof WorkloadIndexStatusSchema>;
export type WorkloadTimeRange = z.infer<typeof WorkloadTimeRangeSchema>;
export type WorkloadDatasetSelection = z.infer<
  typeof WorkloadDatasetSelectionSchema
>;
export type WorkloadDatasetSelectionInput = z.input<
  typeof WorkloadDatasetSelectionSchema
>;
export type WorkloadDatasetFreezeRequest = z.infer<
  typeof WorkloadDatasetFreezeRequestSchema
>;
export type WorkloadDatasetFreezeRequestInput = z.input<
  typeof WorkloadDatasetFreezeRequestSchema
>;
export type WorkloadDatasetBody = z.infer<typeof WorkloadDatasetBodySchema>;
export type WorkloadDatasetRecord = z.infer<typeof WorkloadDatasetRecordSchema>;
export type WorkloadDatasetSegment = z.infer<
  typeof WorkloadDatasetSegmentSchema
>;
export type WorkloadDatasetContent = z.infer<
  typeof WorkloadDatasetContentSchema
>;
export type WorkloadDatasetMeta = z.infer<typeof WorkloadDatasetMetaSchema>;
export type WorkloadDatasetManifest = z.infer<
  typeof WorkloadDatasetManifestSchema
>;
export type WorkloadDatasetSummary = z.infer<
  typeof WorkloadDatasetSummarySchema
>;
export type WorkloadSegmentSummary = z.infer<
  typeof WorkloadSegmentSummarySchema
>;
export type WorkloadDatasetDetail = z.infer<typeof WorkloadDatasetDetailSchema>;
export type WorkloadSelectionPreview = z.infer<
  typeof WorkloadSelectionPreviewSchema
>;
export type WorkloadFreezeJob = z.infer<typeof WorkloadFreezeJobSchema>;
export type WorkloadDatasetImportResult = z.infer<
  typeof WorkloadDatasetImportResultSchema
>;

export function workloadPercentile(
  sorted: readonly number[],
  share: number,
): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(share * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

const TYPICAL_FEATURES = [
  "activeSessions",
  "requests",
  "meanInFlight",
  "promptTokensP50",
  "freshPrefillTokens",
  "completionTokensP50",
] as const satisfies ReadonlyArray<keyof WorkloadProfileWindow>;

function typicalScores(windows: WorkloadProfileWindow[]): number[] {
  const medians = TYPICAL_FEATURES.map((feature) =>
    workloadPercentile(
      windows
        .flatMap((window) => {
          const value = window[feature];
          return value === null ? [] : [value];
        })
        .sort((left, right) => left - right),
      0.5,
    ),
  );
  return windows.map((window) =>
    TYPICAL_FEATURES.reduce((score, feature, index) => {
      const value = window[feature];
      const middle = medians[index] ?? null;
      if (value === null || middle === null) {
        return score;
      }
      return score + Math.abs(Math.log((value + 1) / (middle + 1)));
    }, 0),
  );
}

function windowsOverlap(
  left: WorkloadProfileWindow,
  right: WorkloadProfileWindow,
): boolean {
  return left.startAt < right.endAt && right.startAt < left.endAt;
}

export function rankWorkloadWindows(
  windows: WorkloadProfileWindow[],
  rank: WorkloadWindowRank,
  limit: number,
): WorkloadRankedWindow[] {
  const candidates = windows.filter(
    (window) => window.requests > 0 && window.errors === 0,
  );
  const scores =
    rank === "typical"
      ? typicalScores(candidates)
      : candidates.map((window) => window.meanInFlight);
  const ranked = candidates
    .map((window, index) => ({ ...window, score: scores[index] ?? 0 }))
    .sort((left, right) => {
      if (rank === "typical") {
        return (
          left.score - right.score || left.startAt.localeCompare(right.startAt)
        );
      }
      return (
        right.score - left.score ||
        (right.freshPrefillTokens ?? -1) - (left.freshPrefillTokens ?? -1) ||
        left.startAt.localeCompare(right.startAt)
      );
    });
  const picked: WorkloadRankedWindow[] = [];
  for (const window of ranked) {
    if (picked.length >= limit) {
      break;
    }
    if (!picked.some((existing) => windowsOverlap(existing, window))) {
      picked.push(window);
    }
  }
  return picked;
}
