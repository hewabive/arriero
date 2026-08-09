import { z } from "zod";

import { EndpointProbeSchema } from "./llama.js";

export const ApiLabProbeProfileSchema = z.enum([
  "openai",
  "llama-native",
  "anthropic",
]);

export const OpenAiApiProbeKindSchema = z.enum([
  "chat",
  "completion",
  "responses",
  "embeddings",
  "rerank",
]);

export const LlamaNativeApiProbeKindSchema = z.enum([
  "infill",
  "tokenize",
  "detokenize",
  "apply-template",
]);

export const AnthropicApiProbeKindSchema = z.enum(["count-tokens"]);

export const ApiProbeKindSchema = z.enum([
  ...OpenAiApiProbeKindSchema.options,
  ...LlamaNativeApiProbeKindSchema.options,
  ...AnthropicApiProbeKindSchema.options,
]);

export const ApiEndpointIdSchema = z.string().trim().min(1).max(160);
const ApiEndpointNameSchema = z.string().trim().min(1).max(80);
export const ApiEndpointBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Base URL must be an http or https URL" },
  );
const ApiEndpointHeaderNameSchema = z.string().trim().min(1).max(80).nullable();
const ApiEndpointEnvVarSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      !value.startsWith("ARRIERO_") && !value.startsWith("LLAMA_MANAGER_"),
    {
      message: "Env var must not start with ARRIERO_ or LLAMA_MANAGER_",
    },
  )
  .nullable();
const ApiEndpointSecretSchema = z.string().max(4_000).optional();
const ApiEndpointExtraHeadersSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().max(2_000),
);
const ApiEndpointModelPatternSchema = z.string().trim().min(1).max(200);
export const ApiEndpointModelFilterSchema = z
  .object({
    allow: z.array(ApiEndpointModelPatternSchema).max(500).optional(),
    deny: z.array(ApiEndpointModelPatternSchema).max(500).optional(),
  })
  .nullable();

export const ApiEndpointKindSchema = z.enum([
  "manager-proxy",
  "managed-instance",
  "external-api",
]);

const INSTANCE_ENDPOINT_PREFIX = "instance:";

export function instanceEndpointId(instanceId: string): string {
  return `${INSTANCE_ENDPOINT_PREFIX}${instanceId}`;
}

export function instanceIdFromEndpointId(endpointId: string): string | null {
  return endpointId.startsWith(INSTANCE_ENDPOINT_PREFIX)
    ? endpointId.slice(INSTANCE_ENDPOINT_PREFIX.length)
    : null;
}

export const ApiEndpointConfigSchema = z.object({
  id: ApiEndpointIdSchema,
  name: ApiEndpointNameSchema,
  enabled: z.boolean().default(true),
  kind: ApiEndpointKindSchema.default("external-api"),
  baseUrl: ApiEndpointBaseUrlSchema,
  profile: ApiLabProbeProfileSchema.default("openai"),
  apiKeyEnvVar: ApiEndpointEnvVarSchema.default(null),
  authHeaderName: ApiEndpointHeaderNameSchema.default(null),
  extraHeaders: ApiEndpointExtraHeadersSchema.default({}),
  passthrough: z.boolean().default(false),
  modelFilter: ApiEndpointModelFilterSchema.default(null),
  instanceId: z.string().min(1).nullable().default(null),
  nodeId: z.string().min(1).nullable().default(null),
  editable: z.boolean().default(true),
});

export const ApiEndpointCreateSchema = ApiEndpointConfigSchema.omit({
  id: true,
  kind: true,
  instanceId: true,
  nodeId: true,
  editable: true,
})
  .extend({
    apiKey: ApiEndpointSecretSchema,
  })
  .superRefine((input, ctx) => {
    if (input.apiKeyEnvVar && input.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "Set either an API key or an env var name, not both",
      });
    }
  });

export const ApiEndpointUpdateSchema = z.object({
  name: ApiEndpointNameSchema.optional(),
  enabled: z.boolean().optional(),
  baseUrl: ApiEndpointBaseUrlSchema.optional(),
  profile: ApiLabProbeProfileSchema.optional(),
  apiKeyEnvVar: ApiEndpointEnvVarSchema.optional(),
  authHeaderName: ApiEndpointHeaderNameSchema.optional(),
  extraHeaders: ApiEndpointExtraHeadersSchema.optional(),
  passthrough: z.boolean().optional(),
  modelFilter: ApiEndpointModelFilterSchema.optional(),
  apiKey: ApiEndpointSecretSchema,
});

export const ApiEndpointRecordSchema = ApiEndpointConfigSchema.extend({
  authConfigured: z.boolean().default(false),
});

export const ApiLabProbeKindsByProfile = {
  openai: OpenAiApiProbeKindSchema.options,
  "llama-native": LlamaNativeApiProbeKindSchema.options,
  anthropic: ["chat", ...AnthropicApiProbeKindSchema.options],
} as const;

export const ApiProbeRequestSchema = z
  .object({
    kind: ApiProbeKindSchema,
    model: z.string().trim().min(1).max(500).optional(),
    prompt: z.string().max(20_000).default(""),
    inputPrefix: z.string().max(20_000).optional(),
    inputSuffix: z.string().max(20_000).optional(),
    systemPrompt: z.string().max(4_000).optional(),
    tokens: z.array(z.number().int()).max(8_192).optional(),
    documents: z.array(z.string().min(1).max(8_000)).max(64).optional(),
    maxTokens: z.number().int().min(1).max(2_048).default(64),
    temperature: z.number().min(0).max(2).default(0.2),
    autoload: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "detokenize") {
      if (!input.tokens?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tokens"],
          message: "At least one token is required",
        });
      }
      return;
    }

    if (input.kind === "rerank") {
      if (!input.prompt.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "Query is required",
        });
      }
      if (!input.documents?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["documents"],
          message: "At least one document is required",
        });
      }
      return;
    }

    if (!input.prompt.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "Prompt is required",
      });
    }
  });

export const ApiLabProbeTargetRequestSchema = z
  .object({
    profile: ApiLabProbeProfileSchema,
    baseUrl: z.string().trim().min(1).max(2_000).optional(),
    endpointId: ApiEndpointIdSchema.optional(),
    sourceId: z.string().trim().min(1).max(80).optional(),
    apiKey: z.string().trim().min(1).max(4_000).optional(),
    probe: ApiProbeRequestSchema,
  })
  .superRefine((input, ctx) => {
    if (!input.baseUrl && !input.endpointId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "Base URL or endpoint is required",
      });
    }
    if (input.sourceId && input.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "Set either an API key or a request source, not both",
      });
    }
    if (
      !ApiLabProbeKindsByProfile[input.profile].includes(
        input.probe.kind as never,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["probe", "kind"],
        message: `Probe kind ${input.probe.kind} is not available for ${input.profile}`,
      });
    }
  });

export const ApiProbeResultSchema = z.object({
  profile: ApiLabProbeProfileSchema.optional(),
  kind: ApiProbeKindSchema,
  endpoint: z.string(),
  requestBody: z.unknown(),
  response: EndpointProbeSchema,
});

export type ApiLabProbeProfile = z.infer<typeof ApiLabProbeProfileSchema>;
export type ApiEndpointKind = z.infer<typeof ApiEndpointKindSchema>;
export type ApiEndpointModelFilter = z.infer<
  typeof ApiEndpointModelFilterSchema
>;

function apiEndpointModelPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
}

export function apiEndpointModelFilterAdmits(
  filter: ApiEndpointModelFilter,
  modelId: string,
): boolean {
  if (!filter) {
    return true;
  }
  const matches = (pattern: string) =>
    apiEndpointModelPatternToRegExp(pattern).test(modelId);
  if (filter.allow && filter.allow.length > 0 && !filter.allow.some(matches)) {
    return false;
  }
  if (filter.deny && filter.deny.some(matches)) {
    return false;
  }
  return true;
}
export type ApiEndpointConfig = z.infer<typeof ApiEndpointConfigSchema>;
export type ApiEndpointCreate = z.infer<typeof ApiEndpointCreateSchema>;
export type ApiEndpointUpdate = z.infer<typeof ApiEndpointUpdateSchema>;
export type ApiEndpointRecord = z.infer<typeof ApiEndpointRecordSchema>;
export type OpenAiApiProbeKind = z.infer<typeof OpenAiApiProbeKindSchema>;
export type LlamaNativeApiProbeKind = z.infer<
  typeof LlamaNativeApiProbeKindSchema
>;
export type AnthropicApiProbeKind = z.infer<typeof AnthropicApiProbeKindSchema>;
export type ApiProbeKind = z.infer<typeof ApiProbeKindSchema>;
export type ApiProbeRequest = z.infer<typeof ApiProbeRequestSchema>;
export type ApiLabProbeTargetRequest = z.infer<
  typeof ApiLabProbeTargetRequestSchema
>;
export type ApiProbeResult = z.infer<typeof ApiProbeResultSchema>;
