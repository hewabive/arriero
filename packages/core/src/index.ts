import { z } from "zod";

import { BuildSettingsSchema } from "./build.js";
import { EnvironmentRepositorySettingsSchema } from "./environments.js";
import { SystemResourcesSchema } from "./system.js";
import { LlamaSourceSettingsSchema } from "./llama.js";
import { ApiProxyPublicModelStatusSchema } from "./proxy/api-proxy.js";
import { SourceRepositorySpecSchema } from "./sources.js";
import { MemoryPoolViewSchema, ResourceLedgerSchema } from "./resources.js";

export * from "./engine-descriptor.js";
export * from "./ggml.js";
export * from "./instance-resources.js";
export * from "./memory-assessment.js";
export * from "./memory-estimate.js";
export * from "./proxy/request-edits.js";
export * from "./proxy/pipeline-graph.js";
export * from "./proxy/text-replacement.js";
export * from "./proxy/token-scale.js";
export * from "./resources.js";
export * from "./llama.js";
export * from "./instance.js";
export * from "./path-catalog.js";
export * from "./process.js";
export * from "./api-endpoints.js";
export * from "./proxy/pipeline-nodes.js";
export * from "./proxy/api-proxy.js";
export * from "./instance-health.js";
export * from "./filesystem.js";
export * from "./jobs.js";
export * from "./sources.js";
export * from "./build.js";
export * from "./environments.js";
export * from "./update.js";
export * from "./config-git.js";
export * from "./arguments.js";
export * from "./system.js";
export * from "./prerequisites.js";

export const PresetNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const FleetNodeIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);
export const FleetNodeNameSchema = z.string().trim().min(1).max(80);
export const FleetNodeBaseUrlSchema = z.string().trim().url();

export const FleetNodeSchema = z.object({
  id: FleetNodeIdSchema,
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
});
export type FleetNode = z.infer<typeof FleetNodeSchema>;

export const FleetNodeCreateSchema = z.object({
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
  token: z.string().min(1).optional(),
});
export type FleetNodeCreate = z.infer<typeof FleetNodeCreateSchema>;

export const FleetNodeUpdateSchema = z.object({
  name: FleetNodeNameSchema.optional(),
  baseUrl: FleetNodeBaseUrlSchema.optional(),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
});
export type FleetNodeUpdate = z.infer<typeof FleetNodeUpdateSchema>;

export const FleetNodeViewSchema = FleetNodeSchema.extend({
  hasToken: z.boolean(),
});
export type FleetNodeView = z.infer<typeof FleetNodeViewSchema>;

export const FederationCapabilitiesSchema = z.object({
  protocolVersion: z.number().int().positive(),
  instanceKinds: z.array(z.string().min(1)),
  creatableInstanceKinds: z.array(z.string().min(1)),
  unknownInstanceKindsTolerated: z.boolean(),
});
export type FederationCapabilities = z.infer<
  typeof FederationCapabilitiesSchema
>;

export const FleetNodeResultMetaSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  self: z.boolean(),
  baseUrl: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const FleetSystemEntrySchema = FleetNodeResultMetaSchema.extend({
  data: SystemResourcesSchema.nullable(),
});
export type FleetSystemEntry = z.infer<typeof FleetSystemEntrySchema>;

export const FleetResourcesPayloadSchema = z.object({
  pools: z.array(MemoryPoolViewSchema),
  ledger: ResourceLedgerSchema,
  detected: SystemResourcesSchema,
});
export type FleetResourcesPayload = z.infer<typeof FleetResourcesPayloadSchema>;

export const FleetResourcesEntrySchema = FleetNodeResultMetaSchema.extend({
  data: FleetResourcesPayloadSchema.nullable(),
});
export type FleetResourcesEntry = z.infer<typeof FleetResourcesEntrySchema>;

export const AuthStateSchema = z.object({
  enabled: z.boolean(),
  authenticated: z.boolean(),
});

export const AdminLoginSchema = z.object({
  password: z.string().min(1),
});

export const PublicProxyModelSchema = z.object({
  modelId: z.string(),
  status: ApiProxyPublicModelStatusSchema,
});

export const PublicStatusSchema = z.object({
  service: z.object({
    ok: z.boolean(),
    authRequired: z.boolean(),
    checkedAt: z.string(),
  }),
  models: z.object({
    total: z.number().int().nonnegative(),
    loaded: z.number().int().nonnegative(),
    activeRequests: z.number().int().nonnegative(),
    queuedRequests: z.number().int().nonnegative(),
    items: z.array(PublicProxyModelSchema),
  }),
});

export const GgufBaseModelSchema = z.object({
  name: z.string().nullable(),
  organization: z.string().nullable(),
  repoUrl: z.string().nullable(),
});

export const GgufMetadataSchema = z.object({
  name: z.string().nullable(),
  architecture: z.string().nullable(),
  modelType: z.string().nullable(),
  poolingType: z.number().nullable(),
  causalAttention: z.boolean().nullable(),
  hasClassifierHead: z.boolean().nullable(),
  quantization: z.string().nullable(),
  quantizationVersion: z.number().nullable(),
  sizeLabel: z.string().nullable(),
  basename: z.string().nullable(),
  finetune: z.string().nullable(),
  license: z.string().nullable(),
  licenseLink: z.string().nullable(),
  repoUrl: z.string().nullable(),
  version: z.string().nullable(),
  quantizedBy: z.string().nullable(),
  tags: z.array(z.string()),
  baseModels: z.array(GgufBaseModelSchema),
  parameterCount: z.number().nullable(),
  contextLength: z.number().nullable(),
  embeddingLength: z.number().nullable(),
  blockCount: z.number().nullable(),
  leadingDenseBlockCount: z.number().nullable(),
  feedForwardLength: z.number().nullable(),
  expertCount: z.number().nullable(),
  expertUsedCount: z.number().nullable(),
  expertSharedCount: z.number().nullable(),
  expertFeedForwardLength: z.number().nullable(),
  headCount: z.number().nullable(),
  headCountKv: z.number().nullable(),
  attentionKeyLength: z.number().nullable(),
  attentionValueLength: z.number().nullable(),
  attentionKeyLengthMla: z.number().nullable(),
  attentionValueLengthMla: z.number().nullable(),
  slidingWindow: z.number().nullable(),
  slidingWindowPattern: z.union([z.number(), z.array(z.boolean())]).nullable(),
  sharedKvLayers: z.number().nullable(),
  nextnPredictLayers: z.number().nullable(),
  shortConvCacheLength: z.number().nullable(),
  ssmConvKernel: z.number().nullable(),
  ssmGroupCount: z.number().nullable(),
  ssmInnerSize: z.number().nullable(),
  ssmStateSize: z.number().nullable(),
  wkvHeadSize: z.number().nullable(),
  tokenShiftCount: z.number().nullable(),
  kdaHeadDim: z.number().nullable(),
  ropeFreqBase: z.number().nullable(),
  ropeScalingType: z.string().nullable(),
  ropeScalingFactor: z.number().nullable(),
  ropeScalingOrigCtxLen: z.number().nullable(),
  tokenizerModel: z.string().nullable(),
  tokenizerPre: z.string().nullable(),
  addBosToken: z.boolean().nullable(),
  addEosToken: z.boolean().nullable(),
  hasChatTemplate: z.boolean(),
  vocabularySize: z.number().nullable(),
  samplingTemp: z.number().nullable(),
  samplingTopK: z.number().nullable(),
  samplingTopP: z.number().nullable(),
  imatrixDataset: z.string().nullable(),
  imatrixEntries: z.number().nullable(),
  imatrixChunks: z.number().nullable(),
});

export const GgufModelSchema = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  isMmproj: z.boolean(),
  mmprojPaths: z.array(z.string()),
  metadata: GgufMetadataSchema,
  error: z.string().optional(),
});

export const ModelScanRootSourceSchema = z.enum([
  "settings",
  "catalog",
  "llama-cache",
]);

export const ModelScanRootSchema = z.object({
  path: z.string(),
  label: z.string(),
  source: ModelScanRootSourceSchema,
  refId: z.string().nullable(),
  exists: z.boolean(),
});

export const ModelScanResultSchema = z.object({
  roots: z.array(ModelScanRootSchema),
  models: z.array(GgufModelSchema),
  scannedAt: z.string(),
  cache: z.object({
    hits: z.number(),
    misses: z.number(),
  }),
  fromCache: z.boolean().optional(),
});

export const ModelScanSettingsSchema = z.object({
  directory: z.string(),
  maxDepth: z.number().int().min(0).max(16),
});

export const AppSettingsFileSchema = z
  .object({
    modelScan: ModelScanSettingsSchema.optional(),
    sourceRepositories: z.array(SourceRepositorySpecSchema).optional(),
    llamaSource: LlamaSourceSettingsSchema.optional(),
    build: BuildSettingsSchema.omit({ repoPath: true }).optional(),
    environments: EnvironmentRepositorySettingsSchema.optional(),
  })
  .default({});

export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;

export const ModelPresetEntrySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  modelPath: z.string(),
  mmprojPath: z.string().nullable(),
  extraArgs: z.record(z.string(), z.string()).default({}),
});

export const ModelPresetFileSchema = z.object({
  globalArgs: z.record(z.string(), z.string()).default({}),
  rootArgs: z.record(z.string(), z.string()).default({}),
  entries: z.array(ModelPresetEntrySchema).default([]),
});

export const PresetDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  section: z.string().nullable(),
  key: z.string().nullable(),
  line: z.number().int().nullable(),
});

export const ModelPresetSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  mtimeMs: z.number().nullable(),
});

export const PresetValidationSchema = z.object({
  name: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
});

export const ModelPresetDocumentSchema = z.object({
  name: z.string(),
  path: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(PresetDiagnosticSchema),
  file: ModelPresetFileSchema,
  content: z.string(),
  mtimeMs: z.number().nullable(),
});

export const ModelPresetWriteSchema = z.object({
  content: z.string(),
  expectedMtimeMs: z.number().nullable(),
  force: z.boolean().default(false),
});

export const ModelPresetCreateSchema = z.object({
  name: PresetNameSchema,
});

export type AuthState = z.infer<typeof AuthStateSchema>;
export type AdminLogin = z.infer<typeof AdminLoginSchema>;
export type PublicProxyModel = z.infer<typeof PublicProxyModelSchema>;
export type PublicStatus = z.infer<typeof PublicStatusSchema>;
export type GgufBaseModel = z.infer<typeof GgufBaseModelSchema>;
export type GgufMetadata = z.infer<typeof GgufMetadataSchema>;
export type GgufModel = z.infer<typeof GgufModelSchema>;

export type GgufModelRole = "generative" | "embedding" | "reranker";

export const GGUF_POOLING_TYPE_LABELS: Record<number, string> = {
  [-1]: "unspecified",
  0: "none",
  1: "mean",
  2: "cls",
  3: "last",
  4: "rank",
};

export function ggufPoolingTypeLabel(
  value: number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return GGUF_POOLING_TYPE_LABELS[value] ?? `type ${value}`;
}

export function ggufModelRole(
  metadata: Pick<
    GgufMetadata,
    "poolingType" | "causalAttention" | "hasClassifierHead"
  >,
): GgufModelRole {
  if (metadata.poolingType === 4 || metadata.hasClassifierHead) {
    return "reranker";
  }
  if (metadata.causalAttention === false) {
    return "embedding";
  }
  if (metadata.poolingType !== null && metadata.poolingType >= 1) {
    return "embedding";
  }
  return "generative";
}
export type ModelScanRootSource = z.infer<typeof ModelScanRootSourceSchema>;
export type ModelScanRoot = z.infer<typeof ModelScanRootSchema>;
export type ModelScanResult = z.infer<typeof ModelScanResultSchema>;
export type ModelScanSettings = z.infer<typeof ModelScanSettingsSchema>;
export type ModelPresetEntry = z.infer<typeof ModelPresetEntrySchema>;
export type ModelPresetFile = z.infer<typeof ModelPresetFileSchema>;
export type PresetDiagnostic = z.infer<typeof PresetDiagnosticSchema>;
export type ModelPresetSummary = z.infer<typeof ModelPresetSummarySchema>;
export type PresetValidation = z.infer<typeof PresetValidationSchema>;
export type ModelPresetDocument = z.infer<typeof ModelPresetDocumentSchema>;
export type ModelPresetWrite = z.infer<typeof ModelPresetWriteSchema>;
export type ModelPresetCreate = z.infer<typeof ModelPresetCreateSchema>;
