import { z } from "zod";

import {
  ApiEndpointBaseUrlSchema,
  ApiEndpointIdSchema,
  ApiEndpointRecordSchema,
} from "../api-endpoints.js";
import { InstanceMemoryDrawSchema } from "../memory-assessment.js";
import { MemoryPoolKindSchema } from "../resources.js";
import {
  ApiProxyIdSchema,
  ApiProxyNodePortSchema,
  ApiProxyPipelineNodeSchema,
  ApiProxyPortRefSchema,
  PIPELINE_NODE_TYPES,
} from "./pipeline-nodes.js";

export const ApiProxyTargetKindSchema = z.enum([
  "managed-instance",
  "external-api",
]);

export const ApiProxyTargetRoleSchema = z.enum(["interactive", "background"]);
export const ApiProxyRouteToKindSchema = z.enum([
  "target",
  "pipeline",
  "endpoint",
]);
const ApiProxyUpstreamModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .nullable();

export const ApiProxyModelStateSchema = z.enum([
  "unknown",
  "stopped",
  "unloaded",
  "loading",
  "ready",
  "error",
]);

const ApiProxyTargetNameSchema = z.string().min(1).max(80);
const ApiProxyTargetModelSchema = z.string().trim().min(1).max(500).nullable();
const ApiProxyTargetPrioritySchema = z.number().int().min(0).max(10_000);
const ApiProxyTargetSlotIdsSchema = z.array(z.number().int().min(0));
const ApiProxyTargetIdleMsSchema = z.number().int().min(0).nullable();
const ApiProxyModelIdSchema = z.string().trim().min(1).max(500);
const ApiProxyModelOwnerSchema = z.string().trim().min(1).max(80);
const ApiProxyModelDescriptionSchema = z.string().trim().max(500).nullable();

export const ApiProxyRouteToSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("target"), id: ApiProxyIdSchema }),
  z.object({ type: z.literal("pipeline"), id: ApiProxyIdSchema }),
  z.object({
    type: z.literal("endpoint"),
    endpointId: ApiEndpointIdSchema,
    upstreamModel: ApiProxyUpstreamModelSchema.default(null),
  }),
]);

const ApiProxyPipelineNameSchema = z.string().min(1).max(80);

export const ApiProxyTargetRecordSchema = z.object({
  id: ApiProxyIdSchema,
  name: ApiProxyTargetNameSchema,
  endpointId: ApiEndpointIdSchema,
  model: ApiProxyTargetModelSchema.default(null),
  role: ApiProxyTargetRoleSchema.default("interactive"),
  priority: ApiProxyTargetPrioritySchema.default(100),
  preemptible: z.boolean().default(true),
  saveSlotsBeforeUnload: z.boolean().default(false),
  slotIds: ApiProxyTargetSlotIdsSchema.default([]),
  idleUnloadMs: ApiProxyTargetIdleMsSchema.default(null),
});

export const ApiProxyModelRecordSchema = z.object({
  id: ApiProxyIdSchema,
  modelId: ApiProxyModelIdSchema,
  visible: z.boolean().default(false),
  enabled: z.boolean().default(true),
  ownedBy: ApiProxyModelOwnerSchema.default("arriero"),
  targetId: ApiProxyIdSchema.nullable().default(null),
  routeTo: ApiProxyRouteToSchema.nullable().default(null),
  description: ApiProxyModelDescriptionSchema.default(null),
});

export const ApiProxyPublicModelLoadStateSchema = z.enum([
  "unloaded",
  "loading",
  "partial",
  "loaded",
  "failed",
  "disabled",
]);

export const ApiProxyPublicModelStatusSchema = z.object({
  value: ApiProxyPublicModelLoadStateSchema,
  activeRequests: z.number().int().nonnegative(),
  queuedRequests: z.number().int().nonnegative(),
});

const ApiProxyPipelineConfigBaseSchema = z.object({
  id: ApiProxyIdSchema,
  name: ApiProxyPipelineNameSchema,
  enabled: z.boolean().default(true),
  entry: ApiProxyNodePortSchema,
  nodes: z.array(ApiProxyPipelineNodeSchema).max(200).default([]),
});

export const ApiProxyPipelineConfigSchema = ApiProxyPipelineConfigBaseSchema;

export const ApiProxyTargetCreateSchema = ApiProxyTargetRecordSchema.omit({
  id: true,
});

export const ApiProxyTargetUpdateSchema = z.object({
  name: ApiProxyTargetNameSchema.optional(),
  endpointId: ApiEndpointIdSchema.optional(),
  model: ApiProxyTargetModelSchema.optional(),
  role: ApiProxyTargetRoleSchema.optional(),
  priority: ApiProxyTargetPrioritySchema.optional(),
  preemptible: z.boolean().optional(),
  saveSlotsBeforeUnload: z.boolean().optional(),
  slotIds: ApiProxyTargetSlotIdsSchema.optional(),
  idleUnloadMs: ApiProxyTargetIdleMsSchema.optional(),
});

export const ApiProxyModelCreateSchema = ApiProxyModelRecordSchema.omit({
  id: true,
});

export const ApiProxyPipelineCreateSchema =
  ApiProxyPipelineConfigBaseSchema.omit({
    id: true,
  });

export const ApiProxyModelUpdateSchema = z.object({
  modelId: ApiProxyModelIdSchema.optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  ownedBy: ApiProxyModelOwnerSchema.optional(),
  targetId: ApiProxyIdSchema.nullable().optional(),
  routeTo: ApiProxyRouteToSchema.nullable().optional(),
  description: ApiProxyModelDescriptionSchema.optional(),
});

export const ApiProxyPipelineUpdateSchema = z.object({
  name: ApiProxyPipelineNameSchema.optional(),
  enabled: z.boolean().optional(),
  entry: ApiProxyPortRefSchema.nullable().optional(),
  nodes: z.array(ApiProxyPipelineNodeSchema).max(200).optional(),
});

export const ApiProxyServeProtocolSchema = z.enum(["openai", "anthropic"]);

export const ApiProxyServeRequestSchema = z.object({
  instanceId: z.string().min(1),
  protocol: ApiProxyServeProtocolSchema,
  endpoint: z.string().min(1),
  stream: z.boolean(),
  model: ApiProxyTargetModelSchema.default(null),
  role: ApiProxyTargetRoleSchema.default("interactive"),
  priority: ApiProxyTargetPrioritySchema.default(100),
  preemptible: z.boolean().default(true),
  saveSlotsBeforeUnload: z.boolean().default(false),
  slotIds: ApiProxyTargetSlotIdsSchema.default([]),
  body: z.unknown(),
});

export const ApiProxyPipelineRecordSchema = ApiProxyPipelineConfigBaseSchema;

export const ApiProxyConfigSchema = z.object({
  models: z.array(ApiProxyModelRecordSchema),
  pipelines: z.array(ApiProxyPipelineRecordSchema).default([]),
  targets: z.array(ApiProxyTargetRecordSchema),
  endpoints: z.array(ApiEndpointRecordSchema).default([]),
});

export const ApiProxyQuickRouteCreateSchema = z.object({
  targetName: ApiProxyTargetNameSchema,
  endpointId: ApiEndpointIdSchema,
  model: ApiProxyTargetModelSchema.default(null),
  modelId: ApiProxyModelIdSchema,
});

export const ApiProxyQuickRouteResultSchema = z.object({
  target: ApiProxyTargetRecordSchema,
  model: ApiProxyModelRecordSchema,
});

export const ApiProxyTargetModelKindSchema = z.enum([
  "managed-instance",
  "external-api",
  "manager-proxy",
]);

export const ApiProxyTargetModelSourceSchema = z.enum(["implied", "probe"]);

export const ApiProxyTargetModelGroupSchema = z.object({
  endpointId: ApiEndpointIdSchema,
  endpointName: z.string().min(1),
  kind: ApiProxyTargetModelKindSchema,
  remote: z.boolean().default(false),
  online: z.boolean().default(false),
  modelSource: ApiProxyTargetModelSourceSchema.default("probe"),
  impliedModel: z.string().min(1).nullable().default(null),
});

export const ApiProxyTargetModelCatalogSchema = z.object({
  groups: z.array(ApiProxyTargetModelGroupSchema).default([]),
});

export const ApiProxyTraceFileSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().nullable().default(null),
  bytes: z.number().int().min(0).default(0),
  createdAt: z.string(),
});

export const ApiProxyRequestFileRecordSchema = z.object({
  traceId: z.string(),
  kind: z.string().min(1),
  label: z.string().nullable().default(null),
  protocol: z.enum(["openai", "anthropic"]),
  endpoint: z.string().min(1),
  routePath: z.string().min(1),
  modelId: ApiProxyModelIdSchema,
  createdAt: z.string(),
  data: z.unknown(),
});

const ApiProxySourceNameSchema = z.string().trim().min(1).max(80);

const ApiProxySourceKeySchema = z.string().trim().max(400).optional();

export const ApiProxySourceConfigSchema = z.object({
  id: ApiProxyIdSchema,
  name: ApiProxySourceNameSchema,
  enabled: z.boolean().default(true),
  note: z.string().trim().max(400).default(""),
  blockedMessage: z.string().trim().max(400).default(""),
});

export const ApiProxySourceCreateSchema = ApiProxySourceConfigSchema.omit({
  id: true,
}).extend({
  apiKey: ApiProxySourceKeySchema,
});

export const ApiProxySourceUpdateSchema = z.object({
  name: ApiProxySourceNameSchema.optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(400).optional(),
  blockedMessage: z.string().trim().max(400).optional(),
  apiKey: ApiProxySourceKeySchema,
});

export const ApiProxySourceRecordSchema = ApiProxySourceConfigSchema.extend({
  keyConfigured: z.boolean().default(false),
});

export const ApiProxySettingsSchema = z.object({
  allowAnonymous: z.boolean().default(true),
});

export const ApiProxySettingsUpdateSchema = z.object({
  allowAnonymous: z.boolean().optional(),
});

export const ApiProxyTraceUsageSchema = z.object({
  promptTokens: z.number().int().min(0).nullable().default(null),
  cacheReadTokens: z.number().int().min(0).nullable().default(null),
  cacheCreationTokens: z.number().int().min(0).nullable().default(null),
  completionTokens: z.number().int().min(0).default(0),
  genMs: z.number().int().min(0).default(0),
  ratePerSecond: z.number().min(0).nullable().default(null),
  prefillMs: z.number().int().min(0).nullable().default(null),
  promptPerSecond: z.number().min(0).nullable().default(null),
});

export const ApiProxyRouteTraceStepSchema = z.object({
  kind: z.enum([...PIPELINE_NODE_TYPES, "enter-pipeline", "fusion-branch"]),
  pipelineId: z.string().nullable().default(null),
  pipelineName: z.string().nullable().default(null),
  nodeId: z.string().nullable().default(null),
  nodeName: z.string().nullable().default(null),
  port: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});

export const ApiProxyRouteExplainRequestSchema = z.object({
  protocol: z.enum(["openai", "anthropic"]).default("openai"),
  body: z.unknown(),
  sourceId: ApiProxyIdSchema.nullable().default(null),
});

export const ApiProxyRouteExplainResultSchema = z.object({
  ok: z.boolean(),
  modelId: z.string(),
  targetId: z.string().nullable().default(null),
  targetName: z.string().nullable().default(null),
  diagnostic: z
    .object({
      status: z.number().int(),
      code: z.string(),
      message: z.string(),
    })
    .nullable()
    .default(null),
  routeTrace: z.array(ApiProxyRouteTraceStepSchema).default([]),
  textReplacementCount: z.number().int().min(0).default(0),
  tokenEstimate: z.number().int().min(0).nullable().default(null),
  transformedBody: z.unknown(),
});

export const ApiProxyTraceCacheOutcomeSchema = z.enum([
  "hit",
  "store",
  "coalesced",
]);

export const ApiProxySchedulerActionTypeSchema = z.enum([
  "start-instance",
  "wait-instance-ready",
  "save-slot",
  "restore-slot",
  "unload-model",
  "stop-instance",
  "load-model",
  "wait-model-ready",
  "route-request",
]);

export const ApiProxySchedulerActionSchema = z.object({
  type: ApiProxySchedulerActionTypeSchema,
  targetId: ApiProxyIdSchema,
  instanceId: z.string().min(1).nullable().default(null),
  model: z.string().nullable(),
  slotId: z.number().int().min(0).nullable().default(null),
  reason: z.string(),
});

const LegacyApiProxySchedulerActionSchema =
  ApiProxySchedulerActionTypeSchema.transform((type) => ({
    type,
    targetId: null,
    instanceId: null,
    model: null,
    slotId: null,
    reason: null,
  }));

export const ApiProxyRequestTraceSchema = z.object({
  id: z.string(),
  at: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  translated: z.boolean().default(false),
  endpoint: z.string().min(1),
  routePath: z.string().min(1),
  modelId: z.string(),
  sourceId: ApiProxyIdSchema.nullable().default(null),
  sourceName: z.string().nullable().default(null),
  stream: z.boolean().nullable().default(null),
  targetId: ApiProxyIdSchema.nullable().default(null),
  targetName: z.string().nullable().default(null),
  slotId: z.number().int().min(0).nullable().default(null),
  cacheOrigin: z.enum(["live", "restored", "fresh"]).nullable().default(null),
  cache: ApiProxyTraceCacheOutcomeSchema.nullable().default(null),
  resumed: z.boolean().default(false),
  textReplacementCount: z.number().int().min(0).default(0),
  routeTrace: z.array(ApiProxyRouteTraceStepSchema).default([]),
  files: z.array(ApiProxyTraceFileSchema).default([]),
  schedulerActions: z
    .array(
      z.union([
        ApiProxySchedulerActionSchema,
        LegacyApiProxySchedulerActionSchema,
      ]),
    )
    .default([]),
  displacedTargetIds: z.array(ApiProxyIdSchema).default([]),
  usage: ApiProxyTraceUsageSchema.nullable().default(null),
  status: z.number().int().min(0).default(0),
  ok: z.boolean().default(false),
  errorCode: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  durationMs: z.number().int().min(0).default(0),
  queueMs: z.number().int().min(0).nullable().default(null),
  ttftMs: z.number().int().min(0).nullable().default(null),
});

export const ApiProxyStatsModelEntrySchema = z.object({
  modelId: z.string(),
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  cacheHits: z.number().int().min(0).default(0),
  resumed: z.number().int().min(0).default(0),
  completionTokens: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  genMs: z.number().int().min(0),
  requestsWithTokens: z.number().int().min(0),
  ratePerSecond: z.number().min(0).nullable(),
});

export const ApiProxyStatsTotalsSchema = z.object({
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  cacheHits: z.number().int().min(0).default(0),
  resumed: z.number().int().min(0).default(0),
  completionTokens: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  genMs: z.number().int().min(0),
  requestsWithTokens: z.number().int().min(0),
  ratePerSecond: z.number().min(0).nullable(),
});

export const ApiProxyStatsBucketSchema = ApiProxyStatsTotalsSchema.extend({
  hour: z.string(),
  byModel: z.array(ApiProxyStatsModelEntrySchema).default([]),
});

export const ApiProxyStatsSnapshotSchema = z.object({
  generatedAt: z.string(),
  hours: z.number().int().min(0),
  totals: ApiProxyStatsTotalsSchema,
  buckets: z.array(ApiProxyStatsBucketSchema).default([]),
});

export const ApiProxyTraceFacetSchema = z.object({
  value: z.string(),
  name: z.string().nullable().default(null),
  count: z.number().int().min(0),
});

export const ApiProxyTraceFacetsSchema = z.object({
  retentionDays: z.number().int().min(1),
  models: z.array(ApiProxyTraceFacetSchema).default([]),
  sources: z.array(ApiProxyTraceFacetSchema).default([]),
  targets: z.array(ApiProxyTraceFacetSchema).default([]),
  endpoints: z.array(ApiProxyTraceFacetSchema).default([]),
  protocols: z.array(ApiProxyTraceFacetSchema).default([]),
  statuses: z.array(ApiProxyTraceFacetSchema).default([]),
  errorCodes: z.array(ApiProxyTraceFacetSchema).default([]),
  fileKinds: z.array(ApiProxyTraceFacetSchema).default([]),
});

const traceQueryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const ApiProxyTraceCacheFilterSchema = z.enum([
  ...ApiProxyTraceCacheOutcomeSchema.options,
  "none",
]);

export const ApiProxyTraceListFilterSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  before: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  protocol: z.string().optional(),
  endpoint: z.string().optional(),
  modelId: z.string().optional(),
  sourceId: z.string().optional(),
  targetId: z.string().optional(),
  ok: traceQueryBooleanSchema.optional(),
  status: z.coerce.number().int().optional(),
  errorCode: z.string().optional(),
  cache: ApiProxyTraceCacheFilterSchema.optional(),
  resumed: traceQueryBooleanSchema.optional(),
  stream: traceQueryBooleanSchema.optional(),
  translated: traceQueryBooleanSchema.optional(),
  hasFiles: traceQueryBooleanSchema.optional(),
  fileKind: z.string().min(1).optional(),
  minDurationMs: z.coerce.number().int().min(0).optional(),
});

export const ApiProxyTraceListQuerySchema =
  ApiProxyTraceListFilterSchema.extend({
    withTotal: traceQueryBooleanSchema.optional(),
  });

export const ApiProxyRuntimeMetadataRecordSchema = z.object({
  targetId: ApiProxyIdSchema,
  savedSlotIds: z.array(z.number().int().min(0)).default([]),
  updatedAt: z.string(),
});

export const ApiProxyInflightPhaseSchema = z.enum([
  "queued",
  "prefilling",
  "thinking",
  "generating",
  "tool",
  "done",
  "failed",
]);

export function apiProxyInflightPhaseEnded(
  phase: z.infer<typeof ApiProxyInflightPhaseSchema>,
): boolean {
  return phase === "done" || phase === "failed";
}

export const ApiProxyInflightToolCallSchema = z.object({
  name: z.string().nullable(),
  arguments: z.string(),
});

export const ApiProxyInflightRequestSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  stream: z.boolean(),
  phase: ApiProxyInflightPhaseSchema,
  waitingMs: z.number().int().min(0),
  prefillMs: z.number().int().min(0).nullable().default(null),
  thinkingMs: z.number().int().min(0).nullable().default(null),
  generatingMs: z.number().int().min(0).nullable().default(null),
  promptTokens: z.number().int().min(0).nullable().default(null),
  completionTokens: z.number().int().min(0).default(0),
  prefillTotalTokens: z.number().int().min(0).nullable().default(null),
  prefillProcessedTokens: z.number().int().min(0).nullable().default(null),
  prefillCachedTokens: z.number().int().min(0).nullable().default(null),
  reasoningChars: z.number().int().min(0).default(0),
  answerChars: z.number().int().min(0).default(0),
  toolCalls: z.number().int().min(0).default(0),
  interruptible: z.boolean().default(false),
});

export const ApiProxyInflightDetailSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  phase: ApiProxyInflightPhaseSchema,
  reasoningText: z.string(),
  reasoningChars: z.number().int().min(0),
  reasoningTruncated: z.boolean(),
  answerText: z.string(),
  answerChars: z.number().int().min(0),
  answerTruncated: z.boolean(),
  toolCalls: z.array(ApiProxyInflightToolCallSchema).default([]),
  completionTokens: z.number().int().min(0),
  interruptible: z.boolean(),
});

export const ApiProxyInflightInterruptResultSchema = z.object({
  status: z.enum(["ok", "not-found", "not-supported", "not-ready", "too-late"]),
});

export const ApiProxyInflightStopResultSchema = z.object({
  status: z.enum(["ok", "not-found"]),
});

export const ApiProxyTargetRuntimeSchema = z.object({
  targetId: ApiProxyIdSchema,
  kind: ApiProxyTargetKindSchema,
  baseUrl: ApiEndpointBaseUrlSchema,
  endpointId: ApiEndpointIdSchema,
  instanceId: z.string().min(1).nullable().default(null),
  model: z.string().trim().min(1).max(500).nullable().default(null),
  state: ApiProxyModelStateSchema.default("unknown"),
  stateDetail: z.string().nullable().default(null),
  activeRequests: z.number().int().min(0).default(0),
  idleSince: z.string().nullable().default(null),
  lastRequestAt: z.string().nullable().default(null),
  savedSlotIds: z.array(z.number().int().min(0)).default([]),
  inflight: z.array(ApiProxyInflightRequestSchema).default([]),
});

export const ApiProxyTargetPlanCapabilitiesSchema = z
  .object({
    modelLoadUnload: z.boolean(),
    slotSave: z.boolean(),
  })
  .default({ modelLoadUnload: true, slotSave: true });

export const ApiProxyTargetPlanInputSchema = ApiProxyTargetRecordSchema.extend({
  instanceId: z.string().min(1).nullable().default(null),
  runtime: ApiProxyTargetRuntimeSchema.optional(),
  draws: z.array(InstanceMemoryDrawSchema).default([]),
  capabilities: ApiProxyTargetPlanCapabilitiesSchema,
});

export const ApiProxySchedulerPoolInputSchema = z.object({
  poolId: z.string().min(1),
  kind: MemoryPoolKindSchema,
  budgetBytes: z.number().int().nonnegative(),
  usedByOthersBytes: z.number().int().nonnegative(),
});

export const ApiProxySchedulerModeSchema = z.enum(["request", "idle"]);

export const ApiProxySchedulerPlanRequestSchema = z.object({
  mode: ApiProxySchedulerModeSchema,
  requestedTargetId: ApiProxyIdSchema.optional(),
  preferredTargetId: ApiProxyIdSchema.optional(),
  now: z.string(),
  targets: z.array(ApiProxyTargetPlanInputSchema),
  pools: z.array(ApiProxySchedulerPoolInputSchema).default([]),
  protectedTargetIds: z.array(ApiProxyIdSchema).optional(),
  pinnedTargetIds: z.array(ApiProxyIdSchema).optional(),
});

export const ApiProxySchedulerPlanSchema = z.object({
  ok: z.boolean(),
  mode: ApiProxySchedulerModeSchema,
  requestedTargetId: z.string().nullable(),
  actions: z.array(ApiProxySchedulerActionSchema),
  preemptTargetIds: z.array(ApiProxyIdSchema).default([]),
  blockingReason: z.string().nullable(),
});

export const ApiProxyRuntimeSnapshotSchema = z.object({
  checkedAt: z.string(),
  targets: z.array(ApiProxyTargetRuntimeSchema),
});

export const ApiProxyPlanPreviewRequestSchema = z.object({
  mode: ApiProxySchedulerModeSchema,
  requestedTargetId: ApiProxyIdSchema.optional(),
  preferredTargetId: ApiProxyIdSchema.optional(),
});

export const ApiProxyPlanPreviewSchema = z.object({
  checkedAt: z.string(),
  runtime: ApiProxyRuntimeSnapshotSchema,
  plan: ApiProxySchedulerPlanSchema,
});

export type ApiProxyTargetKind = z.infer<typeof ApiProxyTargetKindSchema>;
export type ApiProxyTargetRole = z.infer<typeof ApiProxyTargetRoleSchema>;
export type ApiProxyRouteToKind = z.infer<typeof ApiProxyRouteToKindSchema>;
export type ApiProxyModelState = z.infer<typeof ApiProxyModelStateSchema>;
export type ApiProxyRouteTo = z.infer<typeof ApiProxyRouteToSchema>;
export type ApiProxyRouteTraceStep = z.infer<
  typeof ApiProxyRouteTraceStepSchema
>;
export type ApiProxyRouteExplainRequest = z.infer<
  typeof ApiProxyRouteExplainRequestSchema
>;
export type ApiProxyRouteExplainResult = z.infer<
  typeof ApiProxyRouteExplainResultSchema
>;
export type ApiProxyTargetCreate = z.infer<typeof ApiProxyTargetCreateSchema>;
export type ApiProxyTargetUpdate = z.infer<typeof ApiProxyTargetUpdateSchema>;
export type ApiProxyPipelineConfig = z.infer<
  typeof ApiProxyPipelineConfigSchema
>;
export type ApiProxyPipelineCreate = z.infer<
  typeof ApiProxyPipelineCreateSchema
>;
export type ApiProxyPipelineUpdate = z.infer<
  typeof ApiProxyPipelineUpdateSchema
>;
export type ApiProxyModelCreate = z.infer<typeof ApiProxyModelCreateSchema>;
export type ApiProxyModelUpdate = z.infer<typeof ApiProxyModelUpdateSchema>;
export type ApiProxyTargetRecord = z.infer<typeof ApiProxyTargetRecordSchema>;
export type ApiProxyServeRequest = z.infer<typeof ApiProxyServeRequestSchema>;
export type ApiProxyPipelineRecord = z.infer<
  typeof ApiProxyPipelineRecordSchema
>;
export type ApiProxyModelRecord = z.infer<typeof ApiProxyModelRecordSchema>;
export type ApiProxyPublicModelLoadState = z.infer<
  typeof ApiProxyPublicModelLoadStateSchema
>;
export type ApiProxyPublicModelStatus = z.infer<
  typeof ApiProxyPublicModelStatusSchema
>;
export type ApiProxyConfig = z.infer<typeof ApiProxyConfigSchema>;
export type ApiProxyQuickRouteCreate = z.infer<
  typeof ApiProxyQuickRouteCreateSchema
>;
export type ApiProxyQuickRouteResult = z.infer<
  typeof ApiProxyQuickRouteResultSchema
>;
export type ApiProxyTargetModelSource = z.infer<
  typeof ApiProxyTargetModelSourceSchema
>;
export type ApiProxyTargetModelGroup = z.infer<
  typeof ApiProxyTargetModelGroupSchema
>;
export type ApiProxyTargetModelCatalog = z.infer<
  typeof ApiProxyTargetModelCatalogSchema
>;
export type ApiProxyTraceFile = z.infer<typeof ApiProxyTraceFileSchema>;
export type ApiProxyRequestFileRecord = z.infer<
  typeof ApiProxyRequestFileRecordSchema
>;
export type ApiProxySourceConfig = z.infer<typeof ApiProxySourceConfigSchema>;
export type ApiProxySourceCreate = z.infer<typeof ApiProxySourceCreateSchema>;
export type ApiProxySourceUpdate = z.infer<typeof ApiProxySourceUpdateSchema>;
export type ApiProxySourceRecord = z.infer<typeof ApiProxySourceRecordSchema>;
export type ApiProxySettings = z.infer<typeof ApiProxySettingsSchema>;
export type ApiProxySettingsUpdate = z.infer<
  typeof ApiProxySettingsUpdateSchema
>;
export type ApiProxyRequestTrace = z.infer<typeof ApiProxyRequestTraceSchema>;
export type ApiProxyTraceUsage = z.infer<typeof ApiProxyTraceUsageSchema>;
export type ApiProxyStatsModelEntry = z.infer<
  typeof ApiProxyStatsModelEntrySchema
>;
export type ApiProxyStatsTotals = z.infer<typeof ApiProxyStatsTotalsSchema>;
export type ApiProxyStatsBucket = z.infer<typeof ApiProxyStatsBucketSchema>;
export type ApiProxyStatsSnapshot = z.infer<typeof ApiProxyStatsSnapshotSchema>;
export type ApiProxyTraceFacet = z.infer<typeof ApiProxyTraceFacetSchema>;
export type ApiProxyTraceFacets = z.infer<typeof ApiProxyTraceFacetsSchema>;
export type ApiProxyTraceCacheFilter = z.infer<
  typeof ApiProxyTraceCacheFilterSchema
>;
export type ApiProxyTraceListFilter = z.infer<
  typeof ApiProxyTraceListFilterSchema
>;
export type ApiProxyTraceListQuery = z.infer<
  typeof ApiProxyTraceListQuerySchema
>;
export type ApiProxyRuntimeMetadataRecord = z.infer<
  typeof ApiProxyRuntimeMetadataRecordSchema
>;
export type ApiProxyInflightPhase = z.infer<typeof ApiProxyInflightPhaseSchema>;
export type ApiProxyInflightRequest = z.infer<
  typeof ApiProxyInflightRequestSchema
>;
export type ApiProxyInflightDetail = z.infer<
  typeof ApiProxyInflightDetailSchema
>;
export type ApiProxyInflightToolCall = z.infer<
  typeof ApiProxyInflightToolCallSchema
>;
export type ApiProxyInflightInterruptResult = z.infer<
  typeof ApiProxyInflightInterruptResultSchema
>;
export type ApiProxyInflightStopResult = z.infer<
  typeof ApiProxyInflightStopResultSchema
>;
export type ApiProxyTargetRuntime = z.infer<typeof ApiProxyTargetRuntimeSchema>;
export type ApiProxyTargetPlanInput = z.infer<
  typeof ApiProxyTargetPlanInputSchema
>;
export type ApiProxySchedulerPoolInput = z.infer<
  typeof ApiProxySchedulerPoolInputSchema
>;
export type ApiProxySchedulerMode = z.infer<typeof ApiProxySchedulerModeSchema>;
export type ApiProxySchedulerActionType = z.infer<
  typeof ApiProxySchedulerActionTypeSchema
>;
export type ApiProxySchedulerAction = z.infer<
  typeof ApiProxySchedulerActionSchema
>;
export type ApiProxySchedulerPlanRequest = z.infer<
  typeof ApiProxySchedulerPlanRequestSchema
>;
export type ApiProxySchedulerPlan = z.infer<typeof ApiProxySchedulerPlanSchema>;
export type ApiProxyRuntimeSnapshot = z.infer<
  typeof ApiProxyRuntimeSnapshotSchema
>;
export type ApiProxyPlanPreviewRequest = z.infer<
  typeof ApiProxyPlanPreviewRequestSchema
>;
export type ApiProxyPlanPreview = z.infer<typeof ApiProxyPlanPreviewSchema>;
