import { z } from "zod";

export const GgufBaseModelSchema = z.object({
  name: z.string().nullable(),
  organization: z.string().nullable(),
  repoUrl: z.string().nullable(),
});

export const GgufChatTemplateReasoningSchema = z.object({
  usesReasoningEffort: z.boolean(),
  usesEnableThinking: z.boolean(),
  levels: z.array(z.string()).nullable(),
  aliases: z.record(z.string(), z.string()).nullable(),
  strict: z.boolean().default(false),
});

export type GgufChatTemplateReasoning = z.infer<
  typeof GgufChatTemplateReasoningSchema
>;

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
  chatTemplateReasoning: GgufChatTemplateReasoningSchema.nullable(),
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

export const SafetensorsKindSchema = z.enum(["model", "adapter", "weights"]);

export const SafetensorsMetadataSchema = z.object({
  kind: SafetensorsKindSchema,
  architecture: z.string().nullable(),
  modelType: z.string().nullable(),
  baseModel: z.string().nullable(),
  torchDtype: z.string().nullable(),
  dominantDtype: z.string().nullable(),
  elementsByDtype: z.array(z.tuple([z.string(), z.number()])),
  quantization: z.string().nullable(),
  quantizationMethod: z.string().nullable(),
  parameterCount: z.number().nullable(),
  visionParameterCount: z.number().nullable(),
  mtpParameterCount: z.number().nullable(),
  tensorCount: z.number().nullable(),
  contextLength: z.number().nullable(),
  embeddingLength: z.number().nullable(),
  blockCount: z.number().nullable(),
  feedForwardLength: z.number().nullable(),
  headCount: z.number().nullable(),
  headCountKv: z.number().nullable(),
  headDim: z.number().nullable(),
  expertCount: z.number().nullable(),
  expertUsedCount: z.number().nullable(),
  expertSharedCount: z.number().nullable(),
  expertFeedForwardLength: z.number().nullable(),
  slidingWindow: z.number().nullable(),
  vocabularySize: z.number().nullable(),
  tieWordEmbeddings: z.boolean().nullable(),
  ropeFreqBase: z.number().nullable(),
  ropeScalingType: z.string().nullable(),
  ropeScalingFactor: z.number().nullable(),
  ropeScalingOrigCtxLen: z.number().nullable(),
  hasChatTemplate: z.boolean(),
  chatTemplateReasoning: GgufChatTemplateReasoningSchema.nullable(),
  samplingTemp: z.number().nullable(),
  samplingTopK: z.number().nullable(),
  samplingTopP: z.number().nullable(),
  transformersVersion: z.string().nullable(),
});

export const SafetensorsModelSchema = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  weightFiles: z.array(z.string()),
  missingShardNames: z.array(z.string()),
  metadata: SafetensorsMetadataSchema,
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

export const ModelScanStatusSchema = z.enum(["idle", "scanning"]);

export const ModelScanStateSchema = z.object({
  status: ModelScanStatusSchema,
  done: z.number(),
  total: z.number(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const ModelScanResultSchema = z.object({
  roots: z.array(ModelScanRootSchema),
  models: z.array(GgufModelSchema),
  safetensors: z.array(SafetensorsModelSchema),
  cache: z.object({
    hits: z.number(),
    misses: z.number(),
  }),
  truncated: z.boolean(),
  scan: ModelScanStateSchema,
});

export const ModelScanRequestSchema = z.object({
  refresh: z.boolean().optional(),
});

export const ModelScanSettingsSchema = z.object({
  directory: z.string(),
  maxDepth: z.number().int().min(0).max(16),
});

export type GgufBaseModel = z.infer<typeof GgufBaseModelSchema>;
export type GgufMetadata = z.infer<typeof GgufMetadataSchema>;
export type GgufModel = z.infer<typeof GgufModelSchema>;
export type SafetensorsKind = z.infer<typeof SafetensorsKindSchema>;
export type SafetensorsMetadata = z.infer<typeof SafetensorsMetadataSchema>;
export type SafetensorsModel = z.infer<typeof SafetensorsModelSchema>;

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
export type ModelScanStatus = z.infer<typeof ModelScanStatusSchema>;
export type ModelScanState = z.infer<typeof ModelScanStateSchema>;
export type ModelScanResult = z.infer<typeof ModelScanResultSchema>;
export type ModelScanRequest = z.infer<typeof ModelScanRequestSchema>;
export type ModelScanSettings = z.infer<typeof ModelScanSettingsSchema>;
