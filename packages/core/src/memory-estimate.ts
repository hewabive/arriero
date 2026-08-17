import { z } from "zod";

import {
  ggmlRowSizeBytes,
  ggmlTypeTraitByName,
  type GgufTensorInfo,
  type GgufTensorTable,
} from "./ggml.js";
import {
  argFlag,
  argNumber,
  argPairedFlag,
  argRaw,
  argString,
  effectiveGpuLayersRaw,
  expertOffloadLayerCount,
  GPU_LAYERS_ARG_KEYS,
  parseTensorSplit,
  resolveGpuLayersValue,
  splitCsvItems,
} from "./instance-resources.js";

export const MEMORY_ESTIMATOR_VERSION = 5;

const F32_BYTES = 4;
const KV_PAD = 256;
const DEFAULT_CTX = 4096;
const DEFAULT_BATCH = 2048;
const DEFAULT_UBATCH = 512;
const DEFAULT_SEQ_MAX = 4;
const DEFAULT_CACHE_TYPE = "f16";
const GPU_CONTEXT_OVERHEAD_BYTES = 400 * 1024 * 1024;
const NGRAM_MOD_HOST_BYTES = 4 * 1024 * 1024 * F32_BYTES;
const NGRAM_MAP_HOST_BYTES_PER_SEQUENCE = 262_144 * 4;

const RS_ROLLBACK_ARCHITECTURES = new Set(["qwen35", "qwen35moe", "deepseek4"]);

const UNQUALIFIED_MTP_ARCHITECTURES = new Set(["step35", "hy_v3", "mimo2"]);

export type MemoryEstimateArgValue =
  | string
  | number
  | boolean
  | string[]
  | null;
export type MemoryEstimateArgs = Record<string, MemoryEstimateArgValue>;

export type MemoryEstimateHparams = {
  architecture: string | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  attentionKeyLength: number | null;
  attentionValueLength: number | null;
  attentionKeyLengthMla: number | null;
  attentionValueLengthMla: number | null;
  causalAttention: boolean | null;
  contextLength: number | null;
  slidingWindow: number | null;
  slidingWindowPattern: number | boolean[] | null;
  sharedKvLayers: number | null;
  nextnPredictLayers: number | null;
  shortConvCacheLength: number | null;
  ssmConvKernel: number | null;
  ssmGroupCount: number | null;
  ssmInnerSize: number | null;
  ssmStateSize: number | null;
  wkvHeadSize: number | null;
  tokenShiftCount: number | null;
  kdaHeadDim: number | null;
  vocabularySize: number | null;
};

export type MemoryEstimatePoolInput = {
  id: string;
  kind: "gpu" | "host";
  deviceIndex?: number | null;
};

export type MemoryEstimateInput = {
  tensors: GgufTensorTable;
  hparams: MemoryEstimateHparams;
  args: MemoryEstimateArgs;
  pools: MemoryEstimatePoolInput[];
  gpuLayersDefault?: string | null;
  mmproj?: { tensors: GgufTensorTable };
  draft?: {
    tensors: GgufTensorTable;
    hparams: MemoryEstimateHparams;
    gpuLayersDefault?: string | null;
  };
  loras?: Array<{ tensors: GgufTensorTable }>;
  controlVector?: boolean;
  rpcWorkerCount?: number;
};

export const ResolvedContextParamsSchema = z.object({
  nCtx: z.number().int().nonnegative(),
  nCtxSeq: z.number().int().nonnegative(),
  nBatch: z.number().int().nonnegative(),
  nUbatch: z.number().int().nonnegative(),
  nSeqMax: z.number().int().positive(),
  kvUnified: z.boolean(),
  swaFull: z.boolean(),
  flashAttn: z.boolean(),
  typeK: z.string(),
  typeV: z.string(),
  offloadKqv: z.boolean(),
  nGpuLayers: z.number().int(),
});

export const MemoryEstimatePoolBreakdownSchema = z.object({
  poolId: z.string(),
  kind: z.enum(["gpu", "host"]),
  weightsBytes: z.number().int().nonnegative(),
  kvBytes: z.number().int().nonnegative(),
  computeBytes: z.number().int().nonnegative(),
  overheadBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export const MemoryEstimateConfidenceSchema = z.enum(["high", "medium", "low"]);

export const MemoryEstimateSchema = z.object({
  draws: z.array(
    z.object({
      poolId: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  pools: z.array(MemoryEstimatePoolBreakdownSchema),
  weightsBytesTotal: z.number().int().nonnegative(),
  kvBytesTotal: z.number().int().nonnegative(),
  computeBytesTotal: z.number().int().nonnegative(),
  overheadBytesTotal: z.number().int().nonnegative(),
  mmprojBytesTotal: z.number().int().nonnegative(),
  draftBytesTotal: z.number().int().nonnegative(),
  loraBytesTotal: z.number().int().nonnegative(),
  controlVectorBytesTotal: z.number().int().nonnegative(),
  selfMtpBytesTotal: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  context: ResolvedContextParamsSchema,
  confidence: MemoryEstimateConfidenceSchema,
  warnings: z.array(z.string()),
});

export type ResolvedContextParams = z.infer<typeof ResolvedContextParamsSchema>;
export type MemoryEstimatePoolBreakdown = z.infer<
  typeof MemoryEstimatePoolBreakdownSchema
>;
export type MemoryEstimateConfidence = z.infer<
  typeof MemoryEstimateConfidenceSchema
>;
export type MemoryEstimate = z.infer<typeof MemoryEstimateSchema>;

function pad(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}

function cacheTypeId(value: string): number | null {
  return ggmlTypeTraitByName(value)?.id ?? null;
}

export function resolveContextParams(
  args: MemoryEstimateArgs,
  hparams: MemoryEstimateHparams,
  hasGpu = false,
  gpuLayersDefault: string | null = null,
): ResolvedContextParams {
  const nCtxTrain = hparams.contextLength ?? DEFAULT_CTX;
  const requestedCtx = argNumber(args, ["--ctx-size", "-c", "--context-size"]);
  const nCtxRequested =
    requestedCtx !== null && requestedCtx > 0 ? requestedCtx : nCtxTrain;

  const requestedSeq = argNumber(args, ["--parallel", "-np"]);
  const parallelIsAuto = requestedSeq === null || requestedSeq < 0;
  const nSeqMax =
    requestedSeq && requestedSeq > 0 ? requestedSeq : DEFAULT_SEQ_MAX;

  const kvUnified = parallelIsAuto
    ? true
    : argPairedFlag(
        args,
        ["--kv-unified", "-kvu"],
        ["--no-kv-unified", "-no-kvu"],
        false,
      );
  const swaFull = argFlag(args, ["--swa-full"]) ?? false;

  const nCtxPadded = pad(nCtxRequested, KV_PAD);
  const nCtxSeq = kvUnified
    ? nCtxPadded
    : pad(Math.floor(nCtxPadded / nSeqMax), KV_PAD);
  const nCtx = kvUnified ? nCtxPadded : nCtxSeq * nSeqMax;

  const requestedBatch = argNumber(args, ["--batch-size", "-b"]);
  const configuredBatch =
    requestedBatch !== null && requestedBatch > 0
      ? requestedBatch
      : DEFAULT_BATCH;
  const attention = argString(args, ["--attention"])?.toLowerCase();
  const causalAttention =
    attention === "causal"
      ? true
      : attention === "non-causal"
        ? false
        : hparams.causalAttention !== false;
  let nBatch = causalAttention
    ? Math.min(nCtxRequested, configuredBatch)
    : configuredBatch;

  const requestedUbatch = argNumber(args, ["--ubatch-size", "-ub"]);
  const nUbatch = Math.min(
    nBatch,
    requestedUbatch === 0
      ? nBatch
      : requestedUbatch !== null && requestedUbatch > 0
        ? requestedUbatch
        : DEFAULT_UBATCH,
  );
  if (
    (argFlag(args, ["--embedding", "--embeddings"]) === true ||
      argFlag(args, ["--rerank", "--reranking"]) === true) &&
    nBatch > nUbatch
  ) {
    nBatch = nUbatch;
  }

  const flashAttnRequested = argFlag(args, ["--flash-attn", "-fa"]);
  const splitMode = argString(args, ["--split-mode", "-sm"])?.toLowerCase();
  const typeV =
    argString(args, ["--cache-type-v", "-ctv"]) ?? DEFAULT_CACHE_TYPE;
  const quantizedV = (ggmlTypeTraitByName(typeV)?.blockSize ?? 1) > 1;
  const flashAttn =
    hparams.architecture?.toLowerCase() === "grok"
      ? false
      : (flashAttnRequested ?? (splitMode === "tensor" || quantizedV));
  const offloadKqv = argPairedFlag(
    args,
    ["--kv-offload", "-kvo"],
    ["--no-kv-offload", "-nkvo"],
    true,
  );

  const typeK =
    argString(args, ["--cache-type-k", "-ctk"]) ?? DEFAULT_CACHE_TYPE;
  return {
    nCtx,
    nCtxSeq,
    nBatch,
    nUbatch,
    nSeqMax,
    kvUnified,
    swaFull,
    flashAttn,
    typeK,
    typeV,
    offloadKqv,
    nGpuLayers: gpuLayersAreAuto(args, GPU_LAYERS_ARG_KEYS, gpuLayersDefault)
      ? hasGpu
        ? (hparams.blockCount ?? 0) + 1
        : 0
      : resolveGpuLayersValue(
          effectiveGpuLayersRaw(args, GPU_LAYERS_ARG_KEYS, gpuLayersDefault),
          hparams.blockCount,
        ),
  };
}

const LAYER_PATTERN = /^blk\.(\d+)\./;
const EXPERT_PATTERN = /ffn_(up|down|gate|gate_up)_(ch)?exps/;
const ATTN_K_PATTERN = /^blk\.(\d+)\.attn_k\.weight$/;
const ATTN_V_PATTERN = /^blk\.(\d+)\.attn_v\.weight$/;
const ATTN_QKV_PATTERN = /^blk\.(\d+)\.attn_qkv\.weight$/;
const ATTN_KV_A_MQA_PATTERN = /^blk\.(\d+)\.attn_kv_a_mqa\.weight$/;
const INPUT_TENSOR_PATTERN = /^(token_embd|per_layer_token_embd)\b/;
const OUTPUT_TENSOR_PATTERN = /^(output|output_norm)\b/;
const MLA_PATTERN = /attn_(kv_a_mqa|kv_b|k_b|v_b)/;
const RECURRENT_PATTERN = /(ssm_|linear_attn|time_mix|conv1d|shortconv)/;

function tensorLayerIndex(name: string): number | null {
  const match = LAYER_PATTERN.exec(name);
  return match ? Number(match[1]) : null;
}

function kvGeometryDim(tensor: GgufTensorInfo): number {
  if (tensor.dims.length >= 2) {
    return tensor.dims[1] ?? 0;
  }
  return tensor.dims[0] ?? 0;
}

type GpuPool = { id: string; index: number };

function gpuPoolsSorted(pools: MemoryEstimatePoolInput[]): GpuPool[] {
  return pools
    .filter((pool) => pool.kind === "gpu")
    .map((pool, fallback) => ({
      id: pool.id,
      index: pool.deviceIndex ?? fallback,
    }))
    .sort((left, right) => left.index - right.index);
}

function gpuPoolForLayer(
  positionRatio: number,
  gpuPools: GpuPool[],
  split: number[],
): string {
  const total = split.reduce((sum, value) => sum + value, 0) || 1;
  let cumulative = 0;
  for (let index = 0; index < gpuPools.length; index += 1) {
    cumulative += (split[index] ?? 0) / total;
    if (positionRatio < cumulative || index === gpuPools.length - 1) {
      return gpuPools[index]!.id;
    }
  }
  return gpuPools[gpuPools.length - 1]!.id;
}

type Placement = {
  layerDevice: (layer: number) => string;
  hostPoolId: string;
  expertHostLayers: number;
  usesGpu: boolean;
  accelerationDisabled: boolean;
};

function buildPlacement(
  input: MemoryEstimateInput,
  context: ResolvedContextParams,
): Placement {
  const hostPool =
    input.pools.find((pool) => pool.kind === "host") ?? input.pools[0];
  const hostPoolId = hostPool?.id ?? "host";
  const gpuPools = gpuPoolsSorted(input.pools);
  const layerAll = (input.hparams.blockCount ?? 0) + 1;
  const nGpu = context.nGpuLayers;
  const splitMode =
    argString(input.args, ["--split-mode", "-sm"])?.toLowerCase() ?? "layer";
  const requestedMainGpu = Math.floor(
    argNumber(input.args, ["--main-gpu", "-mg"]) ?? 0,
  );
  const accelerationDisabled = splitMode === "none" && requestedMainGpu < 0;

  if (gpuPools.length === 0 || nGpu <= 0 || accelerationDisabled) {
    return {
      layerDevice: () => hostPoolId,
      hostPoolId,
      expertHostLayers: expertOffloadLayerCount(input.args, layerAll),
      usesGpu: false,
      accelerationDisabled,
    };
  }

  const split = parseTensorSplit(input.args, gpuPools.length);
  const mainGpu =
    gpuPools.find((pool) => pool.index === requestedMainGpu) ??
    gpuPools[requestedMainGpu] ??
    gpuPools[0]!;
  const iGpuStart = Math.max(layerAll - nGpu, 0);
  const gpuLayerCount = Math.max(layerAll - iGpuStart, 1);

  return {
    layerDevice: (layer: number) => {
      if (layer < iGpuStart) {
        return hostPoolId;
      }
      if (splitMode === "none") {
        return mainGpu.id;
      }
      const ratio = (layer - iGpuStart) / gpuLayerCount;
      return gpuPoolForLayer(ratio, gpuPools, split);
    },
    hostPoolId,
    expertHostLayers: expertOffloadLayerCount(input.args, layerAll),
    usesGpu: true,
    accelerationDisabled,
  };
}

type PoolAccumulator = {
  weightsBytes: number;
  kvBytes: number;
  computeBytes: number;
  overheadBytes: number;
};

function emptyAccumulator(): PoolAccumulator {
  return { weightsBytes: 0, kvBytes: 0, computeBytes: 0, overheadBytes: 0 };
}

function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

type ModelAccumulation = {
  context: ResolvedContextParams;
  placement: Placement;
  computeUsesGpu: boolean;
  kv: KvEstimate;
  computeBytes: number;
  weightsBytes: number;
  layerAll: number;
};

type ContextLayerMode = "main" | "mtp" | "shared-target-kv";

function hasSpeculativeType(
  args: MemoryEstimateArgs,
  expected: string | readonly string[],
): boolean {
  const expectedTypes = new Set(
    (Array.isArray(expected) ? expected : [expected]).map((value) =>
      value.toLowerCase(),
    ),
  );
  const value = argRaw(args, ["--spec-type"]);
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (item) =>
      typeof item === "string" &&
      splitCsvItems(item).some((type) => expectedTypes.has(type.toLowerCase())),
  );
}

export const DRAFT_GPU_LAYERS_ARG_KEYS = [
  "--spec-draft-ngl",
  "-ngld",
  "--n-gpu-layers-draft",
  "--gpu-layers-draft",
];

function gpuLayersAreAuto(
  args: MemoryEstimateArgs,
  keys: string[],
  binaryDefault: string | null,
): boolean {
  const raw = effectiveGpuLayersRaw(args, keys, binaryDefault);
  return typeof raw === "string" && raw.trim().toLowerCase() === "auto";
}

function opOffloadEnabled(args: MemoryEstimateArgs): boolean {
  return argPairedFlag(args, ["--op-offload"], ["--no-op-offload"], true);
}

function draftBackendSamplingEnabled(args: MemoryEstimateArgs): boolean {
  return argPairedFlag(
    args,
    ["--spec-draft-backend-sampling"],
    ["--no-spec-draft-backend-sampling"],
    true,
  );
}

function flashAttnIsAuto(args: MemoryEstimateArgs): boolean {
  const raw = argRaw(args, ["--flash-attn", "-fa"]);
  return (
    raw === undefined ||
    (typeof raw === "string" &&
      ["auto", "-1"].includes(raw.trim().toLowerCase()))
  );
}

function backendSamplingBufferBytes(
  hparams: MemoryEstimateHparams,
  nSeqMax: number,
): number {
  return (3 * (hparams.vocabularySize ?? 0) + 1) * nSeqMax * F32_BYTES;
}

function computePlacement(
  input: MemoryEstimateInput,
  placement: Placement,
  layerAll: number,
): { poolId: string; usesGpu: boolean } {
  if (placement.usesGpu) {
    return {
      poolId: placement.layerDevice(layerAll - 1),
      usesGpu: true,
    };
  }
  if (placement.accelerationDisabled) {
    return { poolId: placement.hostPoolId, usesGpu: false };
  }
  const firstGpu = gpuPoolsSorted(input.pools)[0];
  if (firstGpu && opOffloadEnabled(input.args)) {
    return { poolId: firstGpu.id, usesGpu: true };
  }
  return { poolId: placement.hostPoolId, usesGpu: false };
}

function speculativeRollbackDepth(input: MemoryEstimateInput): number {
  const architecture = input.hparams.architecture?.toLowerCase() ?? "";
  if (
    !RS_ROLLBACK_ARCHITECTURES.has(architecture) ||
    !hasSpeculativeType(input.args, [
      "draft-mtp",
      "draft-eagle3",
      "draft-dflash",
      "draft-dspark",
    ])
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor(argNumber(input.args, ["--spec-draft-n-max"]) ?? 3),
  );
}

function accumulateModel(
  model: MemoryEstimateInput,
  ensure: (poolId: string) => PoolAccumulator,
  warnings: string[],
  contextLayerMode: ContextLayerMode = "main",
): ModelAccumulation {
  const gpuLayersDefault = model.gpuLayersDefault ?? null;
  const context = resolveContextParams(
    model.args,
    model.hparams,
    model.pools.some((pool) => pool.kind === "gpu"),
    gpuLayersDefault,
  );
  if (
    model.pools.some((pool) => pool.kind === "gpu") &&
    gpuLayersAreAuto(model.args, GPU_LAYERS_ARG_KEYS, gpuLayersDefault)
  ) {
    warnings.push(
      "GPU layers are set to upstream auto; the estimate uses full offload as a conservative upper bound. Set --n-gpu-layers explicitly for exact placement.",
    );
  }
  const placement = buildPlacement(model, context);
  const layerAll = (model.hparams.blockCount ?? 0) + 1;

  const weightDevice = (tensor: GgufTensorInfo): string => {
    const layer = tensorLayerIndex(tensor.name);
    if (INPUT_TENSOR_PATTERN.test(tensor.name)) {
      return placement.hostPoolId;
    }
    if (
      layer !== null &&
      EXPERT_PATTERN.test(tensor.name) &&
      layer < placement.expertHostLayers
    ) {
      return placement.hostPoolId;
    }
    if (layer !== null) {
      return placement.layerDevice(layer);
    }
    if (OUTPUT_TENSOR_PATTERN.test(tensor.name)) {
      return placement.layerDevice(layerAll - 1);
    }
    return placement.hostPoolId;
  };

  let weightsBytes = 0;
  for (const tensor of model.tensors.tensors) {
    ensure(weightDevice(tensor)).weightsBytes += tensor.bytes;
    weightsBytes += tensor.bytes;
  }

  const outputWeight = model.tensors.tensors.find(
    (tensor) => tensor.name === "output.weight",
  );
  const tokenEmbedding = model.tensors.tensors.find(
    (tensor) => tensor.name === "token_embd.weight",
  );
  if (placement.usesGpu && !outputWeight && tokenEmbedding) {
    ensure(placement.layerDevice(layerAll - 1)).weightsBytes +=
      tokenEmbedding.bytes;
    weightsBytes += tokenEmbedding.bytes;
    warnings.push(
      `Tied output embedding: llama.cpp keeps token_embd.weight on the host and duplicates ~${mib(
        tokenEmbedding.bytes,
      )} MiB on the output GPU because output.weight is absent.`,
    );
  }

  const kv = estimateKvCache(model, context, warnings, contextLayerMode);
  for (const [layer, bytes] of kv.bytesByLayer) {
    const device = context.offloadKqv
      ? placement.layerDevice(layer)
      : placement.hostPoolId;
    ensure(device).kvBytes += bytes;
  }

  const computeTarget = computePlacement(model, placement, layerAll);
  const compute = estimateComputeReservation(
    model,
    context,
    computeTarget.usesGpu,
  );
  const computeBytes = compute.primaryBytes + compute.hostBytes;
  ensure(computeTarget.poolId).computeBytes += compute.primaryBytes;
  ensure(placement.hostPoolId).computeBytes += compute.hostBytes;

  return {
    context,
    placement,
    computeUsesGpu: computeTarget.usesGpu,
    kv,
    computeBytes,
    weightsBytes,
    layerAll,
  };
}

function mmprojPlacement(
  input: MemoryEstimateInput,
  hostPoolId: string,
): { poolId: string; isGpu: boolean } {
  const gpuPools = gpuPoolsSorted(input.pools);
  const offloadDisabled =
    (argFlag(input.args, ["--no-mmproj-offload"]) ?? false) ||
    argFlag(input.args, ["--mmproj-offload"]) === false;
  const firstGpu = gpuPools[0];
  if (firstGpu && !offloadDisabled) {
    return { poolId: firstGpu.id, isGpu: true };
  }
  return { poolId: hostPoolId, isGpu: false };
}

function assertKnownTensorTypes(role: string, table: GgufTensorTable): void {
  if (table.unknownTypeIds.length === 0) {
    return;
  }
  throw new Error(
    `${role} contains unsupported GGML tensor type IDs: ${table.unknownTypeIds.join(", ")}. ` +
      "Update Arriero's GGML type table before using this memory estimate.",
  );
}

function remapDraftArgs(args: MemoryEstimateArgs): MemoryEstimateArgs {
  const draft: MemoryEstimateArgs = {};
  const copy = (target: string, keys: string[]) => {
    const value = argRaw(args, keys);
    if (value !== undefined) {
      draft[target] = value;
    }
  };
  copy("--ctx-size", ["--ctx-size", "-c", "--context-size"]);
  copy("--parallel", ["--parallel", "-np"]);
  copy("--batch-size", ["--batch-size", "-b"]);
  copy("--ubatch-size", ["--ubatch-size", "-ub"]);
  copy("--flash-attn", ["--flash-attn", "-fa"]);
  copy("--kv-unified", ["--kv-unified", "-kvu"]);
  copy("--no-kv-unified", ["--no-kv-unified", "-no-kvu"]);
  copy("--swa-full", ["--swa-full"]);
  copy("--no-kv-offload", ["--no-kv-offload", "-nkvo"]);
  copy("--op-offload", ["--op-offload"]);
  copy("--no-op-offload", ["--no-op-offload"]);
  copy("--split-mode", ["--split-mode", "-sm"]);
  copy("--tensor-split", ["--tensor-split", "-ts"]);
  copy("--main-gpu", ["--main-gpu", "-mg"]);
  copy("--fit", ["--fit", "-fit"]);
  copy("--n-gpu-layers", DRAFT_GPU_LAYERS_ARG_KEYS);
  copy("--cache-type-k", [
    "--spec-draft-type-k",
    "-ctkd",
    "--cache-type-k-draft",
  ]);
  copy("--cache-type-v", [
    "--spec-draft-type-v",
    "-ctvd",
    "--cache-type-v-draft",
  ]);
  copy("--cpu-moe", ["--spec-draft-cpu-moe", "-cmoed", "--cpu-moe-draft"]);
  copy("--n-cpu-moe", [
    "--spec-draft-n-cpu-moe",
    "--spec-draft-ncmoe",
    "-ncmoed",
    "--n-cpu-moe-draft",
  ]);
  return draft;
}

export function estimateInstanceMemory(
  input: MemoryEstimateInput,
): MemoryEstimate {
  assertKnownTensorTypes("Main model", input.tensors);
  if (input.mmproj) {
    assertKnownTensorTypes("Multimodal projector", input.mmproj.tensors);
  }
  if (input.draft) {
    assertKnownTensorTypes("Draft model", input.draft.tensors);
  }
  for (const [index, lora] of (input.loras ?? []).entries()) {
    assertKnownTensorTypes(`LoRA adapter ${index + 1}`, lora.tensors);
  }

  const warnings: string[] = [];

  const accumulators = new Map<string, PoolAccumulator>();
  const ensure = (poolId: string): PoolAccumulator => {
    let accumulator = accumulators.get(poolId);
    if (!accumulator) {
      accumulator = emptyAccumulator();
      accumulators.set(poolId, accumulator);
    }
    return accumulator;
  };

  const main = accumulateModel(input, ensure, warnings);
  const { context, placement, kv } = main;
  const usesMtp = hasSpeculativeType(input.args, "draft-mtp");
  let estimateIncomplete = false;

  const mtpHparams =
    input.draft && (input.draft.hparams.nextnPredictLayers ?? 0) > 0
      ? input.draft.hparams
      : input.hparams;
  const mtpArchitecture = mtpHparams.architecture?.toLowerCase() ?? "";
  if (usesMtp && UNQUALIFIED_MTP_ARCHITECTURES.has(mtpArchitecture)) {
    estimateIncomplete = true;
    warnings.push(
      `${mtpArchitecture} uses a family-specific MTP graph/cache layout; ordinary NextN weights and KV are included, but its complete MTP compute reservation is not hardware-qualified.`,
    );
  }

  const gpuPools = gpuPoolsSorted(input.pools);
  const gpuLayersAuto = gpuLayersAreAuto(
    input.args,
    GPU_LAYERS_ARG_KEYS,
    input.gpuLayersDefault ?? null,
  );
  const fitEnabled = argFlag(input.args, ["--fit", "-fit"]) ?? true;
  const splitModeRaw = argString(input.args, ["--split-mode", "-sm"]);
  const splitMode = splitModeRaw?.toLowerCase() ?? "layer";
  if (
    fitEnabled &&
    argRaw(input.args, ["--ctx-size", "-c", "--context-size"]) === undefined
  ) {
    estimateIncomplete = true;
    warnings.push(
      "--fit is enabled with an unset context size, so current free memory can reduce the model-default context at startup; set --ctx-size explicitly or use --fit off for a reproducible footprint.",
    );
  }
  if (gpuPools.length > 0 && gpuLayersAuto && fitEnabled) {
    estimateIncomplete = true;
    warnings.push(
      "--fit is enabled with automatic GPU layers, so current free device memory can reduce GPU layers or move MoE tensors at startup; set --fit off and the placement arguments explicitly for an assessable footprint.",
    );
  }
  if (
    gpuPools.length > 1 &&
    placement.usesGpu &&
    splitMode !== "none" &&
    argRaw(input.args, ["--tensor-split", "-ts"]) === undefined
  ) {
    estimateIncomplete = true;
    warnings.push(
      "Multiple GPUs are selected without --tensor-split; current llama.cpp divides layers in proportion to free device memory, while the estimate cannot know that startup-time split.",
    );
  }
  if (gpuPools.length > 1 && placement.usesGpu && splitMode === "layer") {
    estimateIncomplete = true;
    warnings.push(
      "Multi-GPU layer placement for weights and KV is modeled, but llama.cpp scheduler scratch and pipeline-parallel buffers are backend-dependent across devices; per-pool compute memory is incomplete.",
    );
  }

  const flashModeForcedByArgs =
    splitMode === "tensor" ||
    (ggmlTypeTraitByName(context.typeV)?.blockSize ?? 1) > 1 ||
    input.hparams.architecture?.toLowerCase() === "grok";
  if (
    main.computeUsesGpu &&
    flashAttnIsAuto(input.args) &&
    !flashModeForcedByArgs
  ) {
    estimateIncomplete = true;
    warnings.push(
      "--flash-attn is auto, so current llama.cpp probes the actual backend graph and may enable or disable Flash Attention at startup; use an explicit on/off mode for reproducible compute placement and buffer sizes.",
    );
  }

  const sleepIdleSeconds = argNumber(input.args, ["--sleep-idle-seconds"]);
  if (sleepIdleSeconds !== null && sleepIdleSeconds > 0) {
    estimateIncomplete = true;
    warnings.push(
      "--sleep-idle-seconds unloads the model, contexts, draft, and multimodal projector while idle; the displayed footprint describes the awake state, not the sleeping state.",
    );
  }

  if (argRaw(input.args, ["--override-kv"]) !== undefined) {
    estimateIncomplete = true;
    warnings.push(
      "--override-kv can replace memory-defining model metadata after GGUF inspection; the resulting geometry is not modeled.",
    );
  }
  if (argFlag(input.args, ["--no-host"]) === true) {
    estimateIncomplete = true;
    warnings.push(
      "--no-host changes the backend buffer types used for host tensors; their placement and repacked size are not modeled.",
    );
  }
  const repackDisabled = !argPairedFlag(
    input.args,
    ["--repack"],
    ["--no-repack", "-nr"],
    true,
  );
  if (repackDisabled) {
    estimateIncomplete = true;
    warnings.push(
      "Weight repacking is disabled, but the estimator does not model backend-specific original-versus-repacked buffer sizes.",
    );
  }
  if (
    argRaw(input.args, ["--load-mode", "-lm"]) !== undefined ||
    argRaw(input.args, [
      "--mmap",
      "--no-mmap",
      "--mlock",
      "--direct-io",
      "-dio",
      "--no-direct-io",
      "-ndio",
    ]) !== undefined
  ) {
    warnings.push(
      "Model load mode changes RSS residency, page-cache sharing, and locking rather than logical tensor bytes; those operating-system effects are outside this static estimate.",
    );
  }

  const architecture = input.hparams.architecture?.toLowerCase() ?? "";
  if (architecture === "minimax-m3") {
    estimateIncomplete = true;
    warnings.push(
      "MiniMax M3 uses an MSA indexer-key cache in addition to attention KV; the indexer cache is not modeled.",
    );
  } else if (architecture === "glm-dsa" || architecture === "deepseek32") {
    estimateIncomplete = true;
    warnings.push(
      "This architecture uses a DSA indexer cache in addition to MLA KV; the indexer cache is not modeled.",
    );
  } else if (architecture === "deepseek4") {
    estimateIncomplete = true;
    warnings.push(
      "DeepSeek V4 uses a dedicated DSV4 memory implementation; its indexer and recurrent/checkpoint state are not modeled.",
    );
  }
  if (isCachelessLogitsModel(input)) {
    warnings.push(
      "Diffusion request scheduling, sampler state, and optional classifier-free-guidance logits are dynamic and are not included in the static context estimate.",
    );
  }

  const ngramMod =
    hasSpeculativeType(input.args, "ngram-mod") ||
    (argFlag(input.args, ["--spec-default"]) ?? false);
  const ngramMapCount =
    Number(hasSpeculativeType(input.args, "ngram-map-k")) +
    Number(hasSpeculativeType(input.args, "ngram-map-k4v"));
  const ngramFixedHostBytes =
    (ngramMod ? NGRAM_MOD_HOST_BYTES : 0) +
    ngramMapCount * NGRAM_MAP_HOST_BYTES_PER_SEQUENCE * context.nSeqMax;
  if (ngramFixedHostBytes > 0) {
    ensure(placement.hostPoolId).overheadBytes += ngramFixedHostBytes;
    warnings.push(
      `N-gram speculative decoding adds ~${mib(ngramFixedHostBytes)} MiB of fixed host tables; map histories can grow further with request tokens.`,
    );
  }
  if (hasSpeculativeType(input.args, "ngram-cache")) {
    estimateIncomplete = true;
    warnings.push(
      "ngram-cache lookup maps are loaded and updated from request history/files; their dynamic host memory is not statically bounded by the model or launch arguments.",
    );
  }

  if (argFlag(input.args, ["--backend-sampling", "-bs"]) === true) {
    const backendSamplingBytes = backendSamplingBufferBytes(
      input.hparams,
      context.nSeqMax,
    );
    ensure(placement.hostPoolId).computeBytes += backendSamplingBytes;
    warnings.push(
      `Backend sampling adds ~${mib(backendSamplingBytes)} MiB of persistent host logits/probabilities/candidate buffers at ${context.nSeqMax} slot(s); request-time output growth remains dynamic.`,
    );
  }

  if (splitModeRaw && !["layer", "none"].includes(splitMode)) {
    estimateIncomplete = true;
    warnings.push(
      `--split-mode ${splitModeRaw} is configured, but its per-row/per-tensor backend placement is not modeled; per-pool placement is incomplete.`,
    );
  }
  if (argRaw(input.args, ["--override-tensor", "-ot"]) !== undefined) {
    estimateIncomplete = true;
    warnings.push(
      "--override-tensor can change individual tensor backends; those placement overrides are not modeled.",
    );
  }
  if (
    (input.rpcWorkerCount ?? 0) > 0 ||
    argRaw(input.args, ["--rpc"]) !== undefined
  ) {
    estimateIncomplete = true;
    warnings.push(
      "RPC devices are configured, but remote tensor placement, remote device overhead, and client-side staging are not modeled; the displayed pool draws cover local pools only.",
    );
  }

  let mmprojBytesTotal = 0;
  let mmprojOnGpu = false;
  if (input.mmproj) {
    const target = mmprojPlacement(input, placement.hostPoolId);
    mmprojOnGpu = target.isGpu;
    for (const tensor of input.mmproj.tensors.tensors) {
      mmprojBytesTotal += tensor.bytes;
    }
    ensure(target.poolId).weightsBytes += mmprojBytesTotal;
    warnings.push(
      `Multimodal projector (--mmproj): ~${mib(mmprojBytesTotal)} MiB of weights included on ${
        target.isGpu ? "the GPU" : "the host"
      }; request-time image/audio/video preprocessing and compute buffers are not modeled.`,
    );
  }

  let draftBytesTotal = 0;
  let draftUsesGpu = false;
  if (input.draft) {
    const draftWarnings: string[] = [];
    const draftGpuLayersDefault = input.draft.gpuLayersDefault ?? null;
    const draftModel: MemoryEstimateInput = {
      tensors: input.draft.tensors,
      hparams: input.draft.hparams,
      args: remapDraftArgs(input.args),
      pools: input.pools,
      gpuLayersDefault: draftGpuLayersDefault,
    };
    const draftGpuLayersAuto = gpuLayersAreAuto(
      input.args,
      DRAFT_GPU_LAYERS_ARG_KEYS,
      draftGpuLayersDefault,
    );
    if (gpuPools.length > 0 && draftGpuLayersAuto && fitEnabled) {
      estimateIncomplete = true;
      warnings.push(
        "--fit is enabled with automatic draft GPU layers, so current free device memory can change draft placement at startup; set --spec-draft-ngl explicitly or use --fit off.",
      );
    }
    const draftSharesTargetKv =
      input.draft.hparams.architecture?.toLowerCase() === "gemma4-assistant";
    const draftIsMtp =
      usesMtp && (input.draft.hparams.nextnPredictLayers ?? 0) > 0;
    const draft = accumulateModel(
      draftModel,
      ensure,
      draftWarnings,
      draftSharesTargetKv ? "shared-target-kv" : draftIsMtp ? "mtp" : "main",
    );
    draftUsesGpu = draft.computeUsesGpu;
    const draftHasBackendSampling =
      draftBackendSamplingEnabled(input.args) &&
      (draftIsMtp || hasSpeculativeType(input.args, "draft-eagle3"));
    const draftBackendSamplingBytes = draftHasBackendSampling
      ? backendSamplingBufferBytes(input.draft.hparams, draft.context.nSeqMax)
      : 0;
    if (draftBackendSamplingBytes > 0) {
      ensure(draft.placement.hostPoolId).computeBytes +=
        draftBackendSamplingBytes;
      warnings.push(
        `Draft backend sampling adds ~${mib(draftBackendSamplingBytes)} MiB of persistent host output buffers; --no-spec-draft-backend-sampling removes them.`,
      );
    }
    draftBytesTotal =
      draft.weightsBytes +
      draft.kv.totalBytes +
      draft.computeBytes +
      draftBackendSamplingBytes;
    warnings.push(
      `Speculative ${draftIsMtp ? "MTP " : ""}draft model (--spec-draft-model): a second resident model (weights + ${draftSharesTargetKv ? "target-shared KV + " : "KV + "}compute, ~${mib(
        draftBytesTotal,
      )} MiB) is included.`,
    );
    for (const warning of draftWarnings) {
      warnings.push(`Draft model: ${warning}`);
    }
    if (draftSharesTargetKv) {
      warnings.push(
        "Gemma 4 assistant reuses the target context's global/SWA KV layers; no duplicate persistent KV buffer is added.",
      );
    } else if (usesMtp && !draftIsMtp) {
      estimateIncomplete = true;
      warnings.push(
        "draft-mtp is configured, but the draft GGUF has no nextn_predict_layers metadata; its context was treated as an ordinary draft model.",
      );
    }

    if (hasSpeculativeType(input.args, "draft-dflash")) {
      warnings.push(
        "DFlash draft weights, metadata-derived global/SWA KV, and model compute buffers are included; request-time extracted-feature and speculative sampler scratch are not modeled.",
      );
    }
    if (hasSpeculativeType(input.args, "draft-eagle3")) {
      estimateIncomplete = true;
      warnings.push(
        "Eagle3 extracted-target-feature, verification-state, and speculative sampler buffers are not modeled; draft weights/KV/ordinary compute alone are incomplete.",
      );
    }
    if (hasSpeculativeType(input.args, "draft-dspark")) {
      warnings.push(
        "DSpark draft weights (including Markov/confidence tensors), metadata-derived KV, and model compute buffers are included; request-time extracted-feature and speculative sampler scratch are not modeled.",
      );
    }
    if (
      argRaw(input.args, ["--spec-draft-device", "-devd", "--device-draft"]) !==
      undefined
    ) {
      estimateIncomplete = true;
      warnings.push(
        "A separate draft device list is configured, but draft placement currently reuses the target model's device pools.",
      );
    }
    if (
      argRaw(input.args, [
        "--spec-draft-override-tensor",
        "-otd",
        "--override-tensor-draft",
      ]) !== undefined
    ) {
      estimateIncomplete = true;
      warnings.push(
        "Draft tensor backend overrides are configured but not modeled.",
      );
    }
  }

  let selfMtpBytesTotal = 0;
  if (usesMtp && !input.draft) {
    const nextnLayers = input.hparams.nextnPredictLayers ?? 0;
    if (nextnLayers <= 0) {
      estimateIncomplete = true;
      warnings.push(
        "draft-mtp is configured without a separate draft model, but the target GGUF has no MTP layers (nextn_predict_layers); llama.cpp will reject this context.",
      );
    } else {
      const mtpArgs = remapDraftArgs(input.args);
      const mtpInput: MemoryEstimateInput = { ...input, args: mtpArgs };
      const mtpContext = resolveContextParams(
        mtpArgs,
        input.hparams,
        input.pools.some((pool) => pool.kind === "gpu"),
      );
      const mtpWarnings: string[] = [];
      const mtpKv = estimateKvCache(mtpInput, mtpContext, mtpWarnings, "mtp");
      for (const [layer, bytes] of mtpKv.bytesByLayer) {
        const device = mtpContext.offloadKqv
          ? placement.layerDevice(layer)
          : placement.hostPoolId;
        ensure(device).kvBytes += bytes;
      }
      const mtpComputeTarget = computePlacement(
        mtpInput,
        placement,
        (input.hparams.blockCount ?? 0) + 1,
      );
      const mtpCompute = estimateComputeReservation(
        mtpInput,
        mtpContext,
        mtpComputeTarget.usesGpu,
      );
      ensure(mtpComputeTarget.poolId).computeBytes += mtpCompute.primaryBytes;
      ensure(placement.hostPoolId).computeBytes += mtpCompute.hostBytes;
      const mtpBackendSamplingBytes = draftBackendSamplingEnabled(input.args)
        ? backendSamplingBufferBytes(input.hparams, mtpContext.nSeqMax)
        : 0;
      if (mtpBackendSamplingBytes > 0) {
        ensure(placement.hostPoolId).computeBytes += mtpBackendSamplingBytes;
        warnings.push(
          `MTP backend sampling adds ~${mib(mtpBackendSamplingBytes)} MiB of persistent host output buffers; --no-spec-draft-backend-sampling removes them.`,
        );
      }
      selfMtpBytesTotal =
        mtpKv.totalBytes +
        mtpCompute.primaryBytes +
        mtpCompute.hostBytes +
        mtpBackendSamplingBytes;
      warnings.push(
        `Built-in MTP: a second context shares the target weights; its ${nextnLayers} NextN layer(s), KV, and compute add ~${mib(selfMtpBytesTotal)} MiB without duplicating model weights.`,
      );
      for (const warning of mtpWarnings) {
        warnings.push(`MTP context: ${warning}`);
      }
      if (mtpKv.kvLayerCount === 0) {
        estimateIncomplete = true;
        warnings.push(
          "MTP layers were declared but their attention KV geometry was not found; the built-in MTP estimate is incomplete.",
        );
      }
    }
  }

  let loraBytesTotal = 0;
  if (input.loras && input.loras.length > 0) {
    const layerAll = (input.hparams.blockCount ?? 0) + 1;
    const loraDevice = (tensor: GgufTensorInfo): string => {
      const baseName = tensor.name.replace(/\.lora_[ab]$/, "");
      const layer = tensorLayerIndex(baseName);
      if (INPUT_TENSOR_PATTERN.test(baseName)) {
        return placement.hostPoolId;
      }
      if (
        layer !== null &&
        EXPERT_PATTERN.test(baseName) &&
        layer < placement.expertHostLayers
      ) {
        return placement.hostPoolId;
      }
      if (layer !== null) {
        return placement.layerDevice(layer);
      }
      if (OUTPUT_TENSOR_PATTERN.test(baseName)) {
        return placement.layerDevice(layerAll - 1);
      }
      return placement.hostPoolId;
    };
    for (const lora of input.loras) {
      for (const tensor of lora.tensors.tensors) {
        ensure(loraDevice(tensor)).weightsBytes += tensor.bytes;
        loraBytesTotal += tensor.bytes;
      }
    }
    warnings.push(
      `${input.loras.length} LoRA adapter(s): ~${mib(loraBytesTotal)} MiB of resident tensors are placed with their base-model layers; backend repacking/fallback copies and adapter graph scratch are not modeled.`,
    );
  }

  let controlVectorBytesTotal = 0;
  if (input.controlVector) {
    const blockCount =
      input.hparams.blockCount === null
        ? null
        : Math.max(
            input.hparams.blockCount - (input.hparams.nextnPredictLayers ?? 0),
            0,
          );
    const embeddingLength = input.hparams.embeddingLength;
    if (
      blockCount !== null &&
      embeddingLength !== null &&
      blockCount > 1 &&
      embeddingLength > 0
    ) {
      const bytesPerLayer = embeddingLength * F32_BYTES;
      for (let layer = 1; layer < blockCount; layer += 1) {
        ensure(placement.layerDevice(layer)).weightsBytes += bytesPerLayer;
        controlVectorBytesTotal += bytesPerLayer;
      }
      warnings.push(
        `Control vector: llama.cpp combines all configured files into one ~${mib(controlVectorBytesTotal)} MiB resident F32 layer buffer.`,
      );
    } else {
      warnings.push(
        "Control vector is configured, but block count or embedding width is missing; its resident buffer is not modeled.",
      );
    }
  }

  for (const [poolId, accumulator] of accumulators) {
    const pool = input.pools.find((candidate) => candidate.id === poolId);
    if (
      pool?.kind === "gpu" &&
      accumulator.weightsBytes +
        accumulator.kvBytes +
        accumulator.computeBytes >
        0
    ) {
      accumulator.overheadBytes += GPU_CONTEXT_OVERHEAD_BYTES;
    }
  }

  if (main.computeUsesGpu || draftUsesGpu || mmprojOnGpu) {
    warnings.push(
      "GPU placement is calibrated against one-device CUDA; backend-specific allocations, multi-GPU splits, and the fixed context overhead remain conservative approximations.",
    );
  }

  const pools: MemoryEstimatePoolBreakdown[] = [...accumulators.entries()]
    .map(([poolId, accumulator]) => {
      const pool = input.pools.find((candidate) => candidate.id === poolId);
      return {
        poolId,
        kind: pool?.kind ?? "host",
        weightsBytes: accumulator.weightsBytes,
        kvBytes: accumulator.kvBytes,
        computeBytes: accumulator.computeBytes,
        overheadBytes: accumulator.overheadBytes,
        totalBytes:
          accumulator.weightsBytes +
          accumulator.kvBytes +
          accumulator.computeBytes +
          accumulator.overheadBytes,
      };
    })
    .sort((left, right) => {
      const order = { gpu: 0, host: 1 } as const;
      return (
        order[left.kind] - order[right.kind] ||
        left.poolId.localeCompare(right.poolId)
      );
    });

  const draws = pools
    .filter((pool) => pool.totalBytes > 0)
    .map((pool) => ({ poolId: pool.poolId, bytes: pool.totalBytes }));

  const weightsBytesTotal = pools.reduce(
    (sum, pool) => sum + pool.weightsBytes,
    0,
  );
  const kvBytesTotal = pools.reduce((sum, pool) => sum + pool.kvBytes, 0);
  const computeBytesTotal = pools.reduce(
    (sum, pool) => sum + pool.computeBytes,
    0,
  );
  const overheadBytesTotal = pools.reduce(
    (sum, pool) => sum + pool.overheadBytes,
    0,
  );

  let confidence = resolveConfidence(input, context, placement, kv, warnings);
  if (estimateIncomplete) {
    confidence = "low";
  }
  if (input.mmproj && confidence === "high") {
    confidence = "medium";
  }

  return {
    draws,
    pools,
    weightsBytesTotal,
    kvBytesTotal,
    computeBytesTotal,
    mmprojBytesTotal,
    draftBytesTotal,
    loraBytesTotal,
    controlVectorBytesTotal,
    selfMtpBytesTotal,
    overheadBytesTotal,
    totalBytes: pools.reduce((sum, pool) => sum + pool.totalBytes, 0),
    context,
    confidence,
    warnings,
  };
}

type KvEstimate = {
  bytesByLayer: Map<number, number>;
  totalBytes: number;
  kvLayerCount: number;
  recurrentLayerCount: number;
  recurrentBytes: number;
  recurrentModeled: boolean;
  mla: boolean;
  mlaModeled: boolean;
  swa: boolean;
  recurrent: boolean;
  cacheless: boolean;
};

const CACHELESS_ARCHITECTURES = new Set([
  "bert",
  "dream",
  "eurobert",
  "gemma-embedding",
  "jina-bert-v2",
  "jina-bert-v3",
  "llada",
  "llada-moe",
  "modern-bert",
  "neo-bert",
  "nomic-bert",
  "nomic-bert-moe",
  "rnd1",
  "wavtokenizer-dec",
]);

const CACHELESS_LOGITS_ARCHITECTURES = new Set([
  "dream",
  "llada",
  "llada-moe",
  "rnd1",
]);

const DEFAULT_SWA_PERIOD: Readonly<Record<string, number>> = {
  gemma2: 2,
  gemma3: 6,
  gemma3n: 5,
  "gpt-oss": 2,
};

function isCachelessModel(input: MemoryEstimateInput): boolean {
  const architecture = input.hparams.architecture?.toLowerCase() ?? "";
  if (CACHELESS_ARCHITECTURES.has(architecture)) {
    return true;
  }
  const attention = argString(input.args, ["--attention"])?.toLowerCase();
  if (attention === "non-causal") {
    return true;
  }
  if (attention === "causal") {
    return false;
  }
  return input.hparams.causalAttention === false;
}

function isCachelessLogitsModel(input: MemoryEstimateInput): boolean {
  const architecture = input.hparams.architecture?.toLowerCase() ?? "";
  return CACHELESS_LOGITS_ARCHITECTURES.has(architecture);
}

function isSwaLayer(
  hparams: MemoryEstimateHparams,
  layer: number,
): boolean | null {
  const configured = hparams.slidingWindowPattern;
  if (Array.isArray(configured)) {
    return configured[layer] ?? false;
  }
  const architecture = hparams.architecture?.toLowerCase() ?? "";
  const period =
    typeof configured === "number"
      ? configured
      : DEFAULT_SWA_PERIOD[architecture];
  if (period === undefined) {
    return null;
  }
  return period === 0 || layer % period < period - 1;
}

function recurrentStateBytesPerLayer(
  hparams: MemoryEstimateHparams,
  nSeqMax: number,
): number | null {
  const nEmbd = hparams.embeddingLength;
  const wkvHeadSize = hparams.wkvHeadSize;
  if (nEmbd !== null && wkvHeadSize !== null && wkvHeadSize > 0) {
    const tokenShiftCount = hparams.tokenShiftCount ?? 2;
    const nEmbdR = tokenShiftCount * nEmbd;
    const nEmbdS = nEmbd * wkvHeadSize;
    return (nEmbdR + nEmbdS) * F32_BYTES * nSeqMax;
  }

  const shortConvCacheLength = hparams.shortConvCacheLength;
  if (
    nEmbd !== null &&
    shortConvCacheLength !== null &&
    shortConvCacheLength > 0
  ) {
    const nEmbdR = nEmbd * Math.max(shortConvCacheLength - 1, 0);
    return nEmbdR * F32_BYTES * nSeqMax;
  }

  const dConv = hparams.ssmConvKernel;
  const kdaHeadDim = hparams.kdaHeadDim;
  const nHead = hparams.headCount;
  if (
    dConv !== null &&
    kdaHeadDim !== null &&
    nHead !== null &&
    kdaHeadDim > 0 &&
    nHead > 0
  ) {
    const dInner = nHead * kdaHeadDim;
    const nEmbdR = 3 * Math.max(dConv - 1, 0) * dInner;
    const nEmbdS = kdaHeadDim * kdaHeadDim * nHead;
    return (nEmbdR + nEmbdS) * F32_BYTES * nSeqMax;
  }
  const dInner = hparams.ssmInnerSize;
  const dState = hparams.ssmStateSize;
  const nGroup =
    hparams.ssmGroupCount ??
    (hparams.architecture?.toLowerCase() === "mamba" ? 0 : null);
  if (
    dConv === null ||
    dInner === null ||
    dState === null ||
    nGroup === null ||
    dInner <= 0 ||
    dState <= 0
  ) {
    return null;
  }
  const nEmbdR = Math.max(dConv - 1, 0) * (dInner + 2 * nGroup * dState);
  const nEmbdS = dState * dInner;
  return (nEmbdR + nEmbdS) * F32_BYTES * nSeqMax;
}

function estimateKvCache(
  input: MemoryEstimateInput,
  context: ResolvedContextParams,
  warnings: string[],
  contextLayerMode: ContextLayerMode = "main",
): KvEstimate {
  if (contextLayerMode === "shared-target-kv") {
    return {
      bytesByLayer: new Map(),
      totalBytes: 0,
      kvLayerCount: 0,
      recurrentLayerCount: 0,
      recurrentBytes: 0,
      recurrentModeled: false,
      mla: false,
      mlaModeled: true,
      swa: input.hparams.slidingWindow !== null,
      recurrent: false,
      cacheless: false,
    };
  }
  if (isCachelessModel(input)) {
    warnings.push(
      isCachelessLogitsModel(input)
        ? "Cacheless diffusion decoder: llama.cpp allocates no persistent KV cache, but its vocabulary-logits and activation buffers are included."
        : "Non-causal encoder/classifier: llama.cpp allocates no persistent KV cache; compute is estimated from the activation width.",
    );
    return {
      bytesByLayer: new Map(),
      totalBytes: 0,
      kvLayerCount: 0,
      recurrentLayerCount: 0,
      recurrentBytes: 0,
      recurrentModeled: false,
      mla: false,
      mlaModeled: false,
      swa: false,
      recurrent: false,
      cacheless: true,
    };
  }

  const kBy = new Map<number, number>();
  const vBy = new Map<number, number>();
  const fusedLayers = new Set<number>();
  const mlaLayers = new Map<number, number>();
  const recurrentLayers = new Set<number>();
  let mla = false;
  let recurrent = false;
  const blockCount = input.hparams.blockCount ?? 0;
  const nextnLayers = Math.min(
    Math.max(input.hparams.nextnPredictLayers ?? 0, 0),
    blockCount,
  );
  const mainLayerCount = blockCount - nextnLayers;
  const layerBelongsToContext = (layer: number): boolean =>
    contextLayerMode === "mtp"
      ? nextnLayers > 0 && layer >= mainLayerCount && layer < blockCount
      : layer < (nextnLayers > 0 ? mainLayerCount : blockCount || Infinity);
  for (const tensor of input.tensors.tensors) {
    const tensorLayer = tensorLayerIndex(tensor.name);
    if (tensorLayer !== null && !layerBelongsToContext(tensorLayer)) {
      continue;
    }
    if (MLA_PATTERN.test(tensor.name)) {
      mla = true;
    }
    if (RECURRENT_PATTERN.test(tensor.name)) {
      recurrent = true;
      const layer = tensorLayerIndex(tensor.name);
      if (layer !== null) {
        recurrentLayers.add(layer);
      }
    }
    const kMatch = ATTN_K_PATTERN.exec(tensor.name);
    if (kMatch) {
      kBy.set(Number(kMatch[1]), kvGeometryDim(tensor));
      continue;
    }
    const vMatch = ATTN_V_PATTERN.exec(tensor.name);
    if (vMatch) {
      vBy.set(Number(vMatch[1]), kvGeometryDim(tensor));
      continue;
    }
    const qkvMatch = ATTN_QKV_PATTERN.exec(tensor.name);
    if (qkvMatch) {
      fusedLayers.add(Number(qkvMatch[1]));
      continue;
    }
    const mlaMatch = ATTN_KV_A_MQA_PATTERN.exec(tensor.name);
    if (mlaMatch) {
      mlaLayers.set(Number(mlaMatch[1]), kvGeometryDim(tensor));
    }
  }

  if (input.hparams.architecture?.toLowerCase() === "kimi-linear") {
    for (const layer of recurrentLayers) {
      kBy.delete(layer);
      vBy.delete(layer);
    }
  }

  const nHead = input.hparams.headCount ?? 0;
  const nHeadKv = input.hparams.headCountKv ?? nHead;
  const defaultHeadLength =
    nHead > 0 ? Math.floor((input.hparams.embeddingLength ?? 0) / nHead) : 0;
  const keyLength = input.hparams.attentionKeyLength ?? defaultHeadLength;
  const valueLength = input.hparams.attentionValueLength ?? defaultHeadLength;
  const fusedKDim = keyLength * nHeadKv;
  const fusedVDim = valueLength * nHeadKv;
  for (const layer of fusedLayers) {
    if (!recurrentLayers.has(layer) && !kBy.has(layer) && fusedKDim > 0) {
      kBy.set(layer, fusedKDim);
      vBy.set(layer, fusedVDim);
    }
  }

  const compressedMla =
    (input.hparams.attentionKeyLengthMla ?? 0) > 0 &&
    (input.hparams.attentionValueLengthMla ?? 0) > 0;
  const mlaModeled =
    mlaLayers.size === 0 ||
    [...mlaLayers.values()].every(
      (tensorDim) => (compressedMla ? tensorDim : fusedKDim) > 0,
    );
  for (const [layer, tensorDim] of mlaLayers) {
    const kDim = compressedMla ? tensorDim : fusedKDim;
    if (!kBy.has(layer) && kDim > 0) {
      kBy.set(layer, kDim);
      if (!compressedMla) {
        vBy.set(layer, fusedVDim);
      }
    }
  }

  const typeKId = cacheTypeId(context.typeK);
  const typeVId = cacheTypeId(context.typeV);
  if (
    (kBy.size > 0 || vBy.size > 0) &&
    (typeKId === null || typeVId === null)
  ) {
    warnings.push(
      `Unknown cache type (${context.typeK}/${context.typeV}); attention KV cache not estimated.`,
    );
    kBy.clear();
    vBy.clear();
  }

  const contextBlockCount =
    contextLayerMode === "mtp"
      ? nextnLayers
      : nextnLayers > 0
        ? mainLayerCount
        : blockCount || kBy.size;
  const sharedKv =
    contextLayerMode === "main" ? (input.hparams.sharedKvLayers ?? 0) : 0;
  const uniqueLayers =
    sharedKv > 0 && sharedKv < contextBlockCount
      ? contextBlockCount - sharedKv
      : contextBlockCount;
  const kvSharingModeled = uniqueLayers < contextBlockCount;

  const swaWindow = input.hparams.slidingWindow;
  const maxKDim = kBy.size > 0 ? Math.max(...kBy.values()) : 0;
  const globalStream = context.kvUnified ? 1 : context.nSeqMax;
  const globalSize = context.nCtxSeq;
  const swaSize =
    swaWindow !== null
      ? context.swaFull
        ? globalSize
        : pad(
            Math.min(
              globalSize,
              swaWindow * (context.kvUnified ? context.nSeqMax : 1) +
                context.nUbatch,
            ),
            KV_PAD,
          )
      : 0;

  const kTypeId = typeKId ?? 0;
  const vTypeId = typeVId ?? 0;
  const bytesByLayer = new Map<number, number>();
  let totalBytes = 0;
  let swaModeled = false;
  for (const [layer, kDim] of kBy) {
    if (contextLayerMode === "main" && layer >= uniqueLayers) {
      continue;
    }
    const swaFromPattern = isSwaLayer(input.hparams, layer);
    const isSwa =
      swaWindow !== null &&
      (swaFromPattern === true || (swaFromPattern === null && kDim < maxKDim));
    if (isSwa) {
      swaModeled = true;
    }
    const size = isSwa ? swaSize : globalSize;
    const kBytes = (ggmlRowSizeBytes(kTypeId, kDim) ?? 0) * size * globalStream;
    const vDim = vBy.get(layer);
    const vBytes =
      vDim !== undefined
        ? (ggmlRowSizeBytes(vTypeId, vDim) ?? 0) * size * globalStream
        : 0;
    const layerBytes = kBytes + vBytes;
    bytesByLayer.set(layer, layerBytes);
    totalBytes += layerBytes;
  }

  const rollbackDepth = speculativeRollbackDepth(input);
  const recurrentStreams = context.nSeqMax * (1 + rollbackDepth);
  const recurrentPerLayer = recurrent
    ? recurrentStateBytesPerLayer(input.hparams, recurrentStreams)
    : null;
  const recurrentModeled =
    recurrentPerLayer !== null && recurrentLayers.size > 0;
  let recurrentBytes = 0;
  if (recurrentModeled) {
    for (const layer of recurrentLayers) {
      bytesByLayer.set(
        layer,
        (bytesByLayer.get(layer) ?? 0) + recurrentPerLayer,
      );
      recurrentBytes += recurrentPerLayer;
    }
    totalBytes += recurrentBytes;
  }

  if (mla && !mlaModeled) {
    warnings.push(
      "Model uses MLA attention but its key/value head lengths are missing; the attention cache is not modeled.",
    );
  } else if (mla) {
    warnings.push(
      `MLA attention: ${kBy.size} layers use ${
        compressedMla
          ? "projection-derived compressed K-only"
          : "metadata-derived legacy K/V"
      } cache geometry.`,
    );
  }
  if (recurrent && !recurrentModeled) {
    warnings.push(
      "Recurrent/SSM layers detected but SSM hyperparameters are missing; recurrent state memory is not modeled.",
    );
  } else if (recurrentModeled) {
    const mib = Math.round(recurrentBytes / (1024 * 1024));
    const rollback =
      rollbackDepth > 0
        ? ` plus ${rollbackDepth} speculative rollback snapshot(s) per sequence`
        : "";
    warnings.push(
      kBy.size > 0
        ? `Hybrid architecture: ${kBy.size} attention + ${recurrentLayers.size} recurrent layers; recurrent state cache (~${mib} MiB at --parallel ${context.nSeqMax}${rollback}) is included and scales with --parallel${rollbackDepth > 0 ? " and --spec-draft-n-max" : ""}.`
        : `Recurrent architecture: ${recurrentLayers.size} layers use a context-independent state cache (~${mib} MiB at --parallel ${context.nSeqMax}${rollback}) that scales with --parallel${rollbackDepth > 0 ? " and --spec-draft-n-max" : ""}.`,
    );
  } else if (kBy.size > 0 && kBy.size < contextBlockCount) {
    warnings.push(
      `Hybrid architecture: ${kBy.size}/${contextBlockCount} layers have a KV cache; the remaining layers' state memory is not modeled.`,
    );
  }
  if (swaWindow !== null && kBy.size > 0) {
    if (swaModeled) {
      const sharing = kvSharingModeled
        ? `; ${sharedKv} of ${contextBlockCount} layers share KV (allocate none)`
        : "";
      warnings.push(
        context.swaFull
          ? `Sliding-window (SWA) model: --swa-full expands SWA layers to the full context${sharing}.`
          : `Sliding-window (SWA) model: SWA layers are capped at the ${swaWindow}-token window and scale with --parallel${sharing}.`,
      );
    } else {
      warnings.push(
        "Sliding-window (SWA) model: KV is an upper bound; per-layer SWA reduction is not modeled for this architecture.",
      );
    }
  } else if (kvSharingModeled && kBy.size > 0) {
    warnings.push(
      `${sharedKv} of ${contextBlockCount} layers share KV (allocate none).`,
    );
  }

  return {
    bytesByLayer,
    totalBytes,
    kvLayerCount: kBy.size,
    recurrentLayerCount: recurrentLayers.size,
    recurrentBytes,
    recurrentModeled,
    mla,
    mlaModeled,
    swa: input.hparams.slidingWindow !== null,
    recurrent,
    cacheless: false,
  };
}

const ACTIVATION_WIDTH_PATTERN =
  /^blk\.\d+\.ffn_(?:up|gate|gate_up)(?:_(?:ch)?exps)?\.weight$/;

function estimateComputeReservation(
  input: MemoryEstimateInput,
  context: ResolvedContextParams,
  usesGpu = false,
): { primaryBytes: number; hostBytes: number } {
  const nVocab = input.hparams.vocabularySize ?? 0;
  const nEmbd = input.hparams.embeddingLength ?? 0;
  const cachelessLogits = isCachelessLogitsModel(input);
  if (cachelessLogits) {
    const activation = nEmbd * context.nUbatch * F32_BYTES;
    return {
      primaryBytes: nVocab * context.nUbatch * F32_BYTES + activation,
      hostBytes: 2 * activation,
    };
  }
  let activationWidth = nEmbd;
  for (const tensor of input.tensors.tensors) {
    if (ACTIVATION_WIDTH_PATTERN.test(tensor.name)) {
      activationWidth = Math.max(
        activationWidth,
        tensor.dims[1] ?? tensor.dims[0] ?? 0,
      );
    }
  }
  const logits = isCachelessModel(input)
    ? 0
    : nVocab * context.nUbatch * F32_BYTES;
  const hasClassifier = input.tensors.tensors.some((tensor) =>
    /^(cls|classifier)\./.test(tensor.name),
  );
  const activation =
    activationWidth *
    context.nUbatch *
    F32_BYTES *
    (isCachelessModel(input) && hasClassifier ? 2 : 1);

  let mlaHostStaging = 0;
  const usesMla = input.tensors.tensors.some((tensor) =>
    MLA_PATTERN.test(tensor.name),
  );
  const typeKId = cacheTypeId(context.typeK);
  const f16TypeId = cacheTypeId(DEFAULT_CACHE_TYPE);
  if (
    usesGpu &&
    context.offloadKqv &&
    usesMla &&
    typeKId !== null &&
    (context.flashAttn || typeKId !== f16TypeId)
  ) {
    const nHead = input.hparams.headCount ?? 0;
    const nHeadKv = input.hparams.headCountKv ?? nHead;
    const defaultHeadLength = nHead > 0 ? Math.floor(nEmbd / nHead) : 0;
    const keyLength = input.hparams.attentionKeyLength ?? defaultHeadLength;
    const keyWidth = keyLength * nHeadKv;
    const keyRowBytes = ggmlRowSizeBytes(typeKId, keyWidth) ?? 0;
    mlaHostStaging = 2 * keyRowBytes * context.nCtxSeq;
  }

  return {
    primaryBytes: logits + activation + (mlaHostStaging > 0 ? activation : 0),
    hostBytes: mlaHostStaging > 0 ? mlaHostStaging : activation,
  };
}

function resolveConfidence(
  input: MemoryEstimateInput,
  context: ResolvedContextParams,
  placement: Placement,
  kv: KvEstimate,
  warnings: string[],
): MemoryEstimateConfidence {
  if (kv.mla && !kv.mlaModeled) {
    return "low";
  }
  if (kv.recurrent && !kv.recurrentModeled) {
    return "low";
  }
  if (kv.kvLayerCount === 0 && !kv.recurrentModeled && !kv.cacheless) {
    return "low";
  }
  if (kv.swa || placement.usesGpu || kv.recurrentModeled) {
    return "medium";
  }
  if (warnings.length > 0) {
    return "medium";
  }
  return "high";
}
