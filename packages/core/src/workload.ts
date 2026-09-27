import { z } from "zod";

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
