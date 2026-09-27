import { z } from "zod";

import { BackgroundJobStatusSchema } from "./jobs.js";

export const WorkloadOutcomeSchema = z.enum([
  "success",
  "client-abort",
  "not-served",
  "error",
]);

export const WorkloadRecordIssueSchema = z.enum([
  "capture-after-rewrite",
  "unsupported-operation",
  "stateful-request",
  "capture-unreadable",
  "body-not-object",
]);

const TokenCountSchema = z.number().int().min(0).nullable();

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
  from: z.string().optional(),
  to: z.string().optional(),
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

export const WorkloadWindowRankSchema = z.enum(["typical", "peak"]);

export const WorkloadWindowRankingQuerySchema =
  WorkloadProfileQuerySchema.extend({
    rank: WorkloadWindowRankSchema.default("typical"),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  });

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

export const WorkloadDatasetBodySchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  messages: z.array(z.string()),
  tools: z.string().nullable(),
  system: z.string().nullable(),
});

export const WorkloadDatasetRecordSchema = z.object({
  traceId: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  endpoint: z.string(),
  routePath: z.string(),
  offsetMs: z.number().int().min(0),
  thinkTimeMs: z.number().int().min(0).nullable(),
  durationMs: z.number().int().min(0),
  outcome: z.enum(["success", "client-abort"]),
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
    windows: z.array(WorkloadTimeRangeSchema).min(1),
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
  population: WorkloadTimeRangeSchema.nullable(),
  profile: WorkloadProfileWindowSchema.nullable(),
  populationProfile: WorkloadProfileWindowSchema.nullable(),
  warnings: z.array(z.string()),
});

export const WORKLOAD_DATASET_ID_PATTERN = /^[0-9a-f]{64}$/;

export const WorkloadDatasetManifestSchema = z.object({
  id: z.string().regex(WORKLOAD_DATASET_ID_PATTERN),
  meta: WorkloadDatasetMetaSchema,
  content: WorkloadDatasetContentSchema,
});

export const WorkloadDatasetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  windows: z.array(WorkloadTimeRangeSchema),
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
export type WorkloadWindowRankingQuery = z.infer<
  typeof WorkloadWindowRankingQuerySchema
>;
export type WorkloadWindowRankingQueryInput = z.input<
  typeof WorkloadWindowRankingQuerySchema
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
