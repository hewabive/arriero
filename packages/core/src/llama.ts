import { z } from "zod";

export const EndpointProbeSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  status: z.number().int().nullable(),
  latencyMs: z.number(),
  body: z.unknown().optional(),
  error: z.string().optional(),
});

export const LlamaModelDiagnosticsSchema = z.object({
  id: z.string(),
  props: EndpointProbeSchema,
  slots: EndpointProbeSchema,
  metrics: EndpointProbeSchema,
  loraAdapters: EndpointProbeSchema,
});

export const LlamaProbeSchema = z.object({
  baseUrl: z.string(),
  health: EndpointProbeSchema,
  props: EndpointProbeSchema,
  slots: EndpointProbeSchema,
  models: EndpointProbeSchema,
  modelDiagnostics: z.record(z.string(), LlamaModelDiagnosticsSchema),
});

export const LlamaCapabilityStatusSchema = z.enum([
  "available",
  "unsupported",
  "error",
]);

export const LlamaCapabilityCategorySchema = z.enum([
  "runtime",
  "models",
  "generation",
  "tokens",
  "embeddings",
]);

export const LlamaCapabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  category: LlamaCapabilityCategorySchema,
  method: z.enum(["GET", "POST"]),
  endpoint: z.string(),
  status: LlamaCapabilityStatusSchema,
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int(),
  reason: z.string().nullable(),
  model: z.string().nullable(),
});

export const LlamaCapabilitiesResultSchema = z.object({
  baseUrl: z.string(),
  checkedAt: z.string(),
  model: z.string().nullable(),
  capabilities: z.array(LlamaCapabilitySchema),
});

export const LlamaModelActionNameSchema = z.enum(["load", "unload", "reload"]);

export const LlamaModelActionRequestSchema = z.object({
  model: z.string().min(1),
});

export const LlamaModelActionResultSchema = z.object({
  action: LlamaModelActionNameSchema,
  model: z.string().nullable(),
  response: EndpointProbeSchema,
  fallback: z.string().nullable().default(null),
});

export const LlamaSlotActionNameSchema = z.enum(["save", "restore", "erase"]);

export const LlamaSlotActionRequestSchema = z.object({
  model: z.string().trim().min(1).max(500).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
});

export const LlamaSlotActionResultSchema = z.object({
  action: LlamaSlotActionNameSchema,
  slotId: z.number().int().min(0),
  model: z.string().nullable(),
  filename: z.string().nullable(),
  response: EndpointProbeSchema,
});

export const LlamaSourceSettingsSchema = z.object({
  repoPath: z.string().min(1),
});

export const LlamaSourceSettingsUpdateSchema = z.object({
  repoPath: z.string().min(1),
});

export const LlamaSourceCheckoutSchema = z.object({
  ref: z.string().trim().min(1),
});

export const LlamaSourceStatusSchema = z.object({
  settings: LlamaSourceSettingsSchema,
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  currentCommit: z.string().nullable(),
  latestTag: z.string().nullable().default(null),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  dirty: z.boolean().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});

export const LlamaSourceRefsSchema = z.object({
  branches: z.array(z.string()),
  branchesWithUpstream: z.array(z.string()),
  tags: z.array(z.string()),
  currentBranch: z.string().nullable(),
  dirty: z.boolean().nullable(),
});

export type EndpointProbe = z.infer<typeof EndpointProbeSchema>;
export type LlamaModelDiagnostics = z.infer<typeof LlamaModelDiagnosticsSchema>;
export type LlamaProbe = z.infer<typeof LlamaProbeSchema>;
export type LlamaCapabilityStatus = z.infer<typeof LlamaCapabilityStatusSchema>;
export type LlamaCapabilityCategory = z.infer<
  typeof LlamaCapabilityCategorySchema
>;
export type LlamaCapability = z.infer<typeof LlamaCapabilitySchema>;
export type LlamaCapabilitiesResult = z.infer<
  typeof LlamaCapabilitiesResultSchema
>;
export type LlamaModelActionName = z.infer<typeof LlamaModelActionNameSchema>;
export type LlamaModelActionRequest = z.infer<
  typeof LlamaModelActionRequestSchema
>;
export type LlamaModelActionResult = z.infer<
  typeof LlamaModelActionResultSchema
>;
export type LlamaSlotActionName = z.infer<typeof LlamaSlotActionNameSchema>;
export type LlamaSlotActionRequest = z.infer<
  typeof LlamaSlotActionRequestSchema
>;
export type LlamaSlotActionResult = z.infer<typeof LlamaSlotActionResultSchema>;
export type LlamaSourceSettings = z.infer<typeof LlamaSourceSettingsSchema>;
export type LlamaSourceSettingsUpdate = z.infer<
  typeof LlamaSourceSettingsUpdateSchema
>;
export type LlamaSourceStatus = z.infer<typeof LlamaSourceStatusSchema>;
export type LlamaSourceRefs = z.infer<typeof LlamaSourceRefsSchema>;
export type LlamaSourceCheckout = z.infer<typeof LlamaSourceCheckoutSchema>;
