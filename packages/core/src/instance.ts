import { z } from "zod";

import { INSTANCE_KINDS, type InstanceKind } from "./engine-descriptor.js";
import { InstanceMemoryDrawSchema } from "./memory-assessment.js";
import { ApiProxyReasoningOverrideSchema } from "./proxy/reasoning.js";

export const InstanceArgValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const InstanceArgsSchema = z.record(z.string(), InstanceArgValueSchema);
export const InstanceEnvSchema = z.record(z.string(), z.string());

const InstanceNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);
const InstancePathSchema = z.string().min(1);
const PathCatalogIdSchema = z.string().min(1);

export const InstanceKindSchema = z.enum(INSTANCE_KINDS);

export const InstanceNumaSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("bind"), node: z.number().int().min(0) }),
  z.object({
    mode: z.literal("interleave"),
    nodes: z.array(z.number().int().min(0)).default([]),
  }),
]);

export const RpcWorkerRefSchema = z.object({
  nodeId: z.string().min(1).nullable().default(null),
  instanceName: InstanceNameSchema,
});

export const KTransformersMethodSchema = z.enum([
  "AMXINT4",
  "AMXINT8",
  "RAWINT4",
  "FP8",
  "FP8_PERCHANNEL",
  "BF16",
  "LLAMAFILE",
]);

export const KTransformersInstanceConfigSchema = z.object({
  type: z.literal("ktransformers"),
  model: z.string().trim().min(1),
  cpuWeights: z.string().trim().min(1),
  method: KTransformersMethodSchema,
  servedModelName: z.string().trim().min(1).optional(),
});

export const InstanceEngineConfigSchema = z.discriminatedUnion("type", [
  KTransformersInstanceConfigSchema,
]);

export const InstanceEvictionPolicySchema = z.enum([
  "never",
  "idle-only",
  "preemptible",
]);

export const InstanceSchedulingPolicySchema = z.object({
  evictionPolicy: InstanceEvictionPolicySchema,
});

export const KTRANSFORMERS_RESERVED_ARG_KEYS = [
  "--model",
  "--model-path",
  "--kt-weight-path",
  "--kt-method",
  "--served-model-name",
] as const;

function validateInstanceEngineFields(
  input: {
    kind: InstanceKind;
    args?: Record<string, unknown> | undefined;
    engineConfig?: z.infer<typeof InstanceEngineConfigSchema> | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (input.kind === "ktransformers") {
    if (input.engineConfig?.type !== "ktransformers") {
      ctx.addIssue({
        code: "custom",
        path: ["engineConfig"],
        message: "KTransformers instances require KTransformers engine config",
      });
    }
  } else if (input.engineConfig?.type === "ktransformers") {
    ctx.addIssue({
      code: "custom",
      path: ["engineConfig", "type"],
      message: `engine config type ktransformers does not match instance kind ${input.kind}`,
    });
  }

  if (input.engineConfig?.type === "ktransformers") {
    for (const key of KTRANSFORMERS_RESERVED_ARG_KEYS) {
      if (input.args && Object.hasOwn(input.args, key)) {
        ctx.addIssue({
          code: "custom",
          path: ["args", key],
          message: `${key} is managed by KTransformers engine config`,
        });
      }
    }
  }
}

export type RpcServerFlag = { short: string; long: string };

export const RPC_SERVER_SUPPORTED_FLAGS: readonly RpcServerFlag[] = [
  { short: "-H", long: "--host" },
  { short: "-p", long: "--port" },
  { short: "-t", long: "--threads" },
  { short: "-d", long: "--device" },
  { short: "-c", long: "--cache" },
];

const InstanceCreateBaseSchema = z.object({
  name: InstanceNameSchema,
  kind: InstanceKindSchema.default("llama-server"),
  binaryPathRefId: PathCatalogIdSchema,
  cwd: InstancePathSchema.optional(),
  args: InstanceArgsSchema.default({}),
  positionalArgs: z.array(z.string()).optional(),
  env: InstanceEnvSchema.default({}),
  memory: z.array(InstanceMemoryDrawSchema).default([]),
  rpcWorkers: z.array(RpcWorkerRefSchema).default([]),
  numa: InstanceNumaSchema.optional(),
  reasoning: ApiProxyReasoningOverrideSchema.optional(),
  engineConfig: InstanceEngineConfigSchema.optional(),
  scheduling: InstanceSchedulingPolicySchema.optional(),
});

export const InstanceCreateSchema = InstanceCreateBaseSchema.superRefine(
  validateInstanceEngineFields,
);

export const InstancePreflightPreviewSchema = InstanceCreateBaseSchema.extend({
  name: InstanceNameSchema.optional(),
}).superRefine(validateInstanceEngineFields);

export const InstanceUpdateSchema = z
  .object({
    name: InstanceNameSchema.optional(),
    binaryPathRefId: PathCatalogIdSchema.optional(),
    cwd: InstancePathSchema.optional(),
    args: InstanceArgsSchema.optional(),
    positionalArgs: z.array(z.string()).optional(),
    env: InstanceEnvSchema.optional(),
    memory: z.array(InstanceMemoryDrawSchema).optional(),
    rpcWorkers: z.array(RpcWorkerRefSchema).optional(),
    numa: InstanceNumaSchema.optional(),
    reasoning: ApiProxyReasoningOverrideSchema.optional(),
    engineConfig: InstanceEngineConfigSchema.optional(),
    scheduling: InstanceSchedulingPolicySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.engineConfig?.type !== "ktransformers") {
      return;
    }
    for (const key of KTRANSFORMERS_RESERVED_ARG_KEYS) {
      if (input.args && Object.hasOwn(input.args, key)) {
        ctx.addIssue({
          code: "custom",
          path: ["args", key],
          message: `${key} is managed by KTransformers engine config`,
        });
      }
    }
  });

export const MemoryEstimateRequestSchema = z.object({
  instanceId: z.string().min(1).optional(),
  kind: InstanceKindSchema.optional(),
  binaryPathRefId: z.string().min(1).optional(),
  args: InstanceArgsSchema.optional(),
  positionalArgs: z.array(z.string()).optional(),
  env: InstanceEnvSchema.optional(),
  rpcWorkers: z.array(RpcWorkerRefSchema).optional(),
});
export type MemoryEstimateRequest = z.infer<typeof MemoryEstimateRequestSchema>;

export const InstanceSchema = InstanceCreateBaseSchema.extend({
  binaryPath: z.string(),
  status: z.enum([
    "stopped",
    "starting",
    "running",
    "stopping",
    "exited",
    "stale",
    "error",
  ]),
  pid: z.number().int().positive().nullable(),
}).superRefine(validateInstanceEngineFields);

export const InstanceStartRequestSchema = z.object({
  force: z.boolean().default(false),
});

export const InstanceConfigRecordSchema = z
  .object({
    name: InstanceNameSchema,
    kind: InstanceKindSchema.default("llama-server"),
    binaryPath: z.string(),
    binaryPathRefId: PathCatalogIdSchema.optional(),
    cwd: InstancePathSchema.optional(),
    args: InstanceArgsSchema.default({}),
    positionalArgs: z.array(z.string()).optional(),
    env: InstanceEnvSchema.default({}),
    memory: z.array(InstanceMemoryDrawSchema).default([]),
    rpcWorkers: z.array(RpcWorkerRefSchema).default([]),
    numa: InstanceNumaSchema.optional(),
    reasoning: ApiProxyReasoningOverrideSchema.optional(),
    engineConfig: InstanceEngineConfigSchema.optional(),
    scheduling: InstanceSchedulingPolicySchema.optional(),
  })
  .superRefine(validateInstanceEngineFields);

export const RpcWorkerCandidateSchema = z.object({
  nodeId: z.string().min(1).nullable(),
  nodeName: z.string(),
  instanceName: InstanceNameSchema,
  endpoint: z.string().nullable(),
  status: InstanceSchema.shape.status,
});

export type InstanceArgValue = z.infer<typeof InstanceArgValueSchema>;
export type InstanceArgs = z.infer<typeof InstanceArgsSchema>;
export type InstanceEnv = z.infer<typeof InstanceEnvSchema>;
export type RpcWorkerRef = z.infer<typeof RpcWorkerRefSchema>;
export type RpcWorkerCandidate = z.infer<typeof RpcWorkerCandidateSchema>;
export type KTransformersMethod = z.infer<typeof KTransformersMethodSchema>;
export type KTransformersInstanceConfig = z.infer<
  typeof KTransformersInstanceConfigSchema
>;
export type InstanceEngineConfig = z.infer<typeof InstanceEngineConfigSchema>;
export type InstanceEvictionPolicy = z.infer<
  typeof InstanceEvictionPolicySchema
>;
export type InstanceSchedulingPolicy = z.infer<
  typeof InstanceSchedulingPolicySchema
>;
export type InstanceCreate = z.infer<typeof InstanceCreateSchema>;
export type InstancePreflightPreview = z.infer<
  typeof InstancePreflightPreviewSchema
>;
export type InstanceUpdate = z.infer<typeof InstanceUpdateSchema>;
export type InstanceStartRequest = z.infer<typeof InstanceStartRequestSchema>;
export type Instance = z.infer<typeof InstanceSchema>;
export type InstanceConfigRecord = z.infer<typeof InstanceConfigRecordSchema>;
export type InstanceNuma = z.infer<typeof InstanceNumaSchema>;
