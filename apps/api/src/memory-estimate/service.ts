import {
  engineDescriptor,
  estimateInstanceMemory,
  argNumber,
  argString,
  parseCudaVisibleDevices,
  parseDeviceTokens,
  MemoryEstimateSchema,
  type InstanceArgs,
  type MemoryEstimate,
  type MemoryEstimateArgs,
  type MemoryEstimateHparams,
  type MemoryEstimatePoolInput,
  type MemoryEstimateRequest,
  type InstanceKind,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { getInstance } from "../instances/repository.js";
import { readGgufMetadata, readGgufModelTensorTable } from "../models/gguf.js";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import { listMemoryPools } from "../resources/repository.js";

export type MemoryEstimateResolution =
  | { ok: true; modelPath: string; estimate: MemoryEstimate }
  | { ok: false; reason: string };

export function poolsForEstimate(
  args: MemoryEstimateArgs,
  env: Record<string, string>,
): MemoryEstimatePoolInput[] {
  const cuda = parseCudaVisibleDevices(env.CUDA_VISIBLE_DEVICES);
  const deviceTokens = parseDeviceTokens(args);
  const explicitCuda = deviceTokens.flatMap((token) => {
    const match = /^cuda(\d+)$/i.exec(token);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  const deviceDisablesGpu = deviceTokens.some(
    (token) => token.toLowerCase() === "none",
  );
  const allPools = listMemoryPools();
  const allGpu = allPools
    .filter((pool) => pool.kind === "gpu")
    .sort(
      (left, right) =>
        Number(left.deviceRef ?? Number.MAX_SAFE_INTEGER) -
        Number(right.deviceRef ?? Number.MAX_SAFE_INTEGER),
    );
  const visibleGpu =
    cuda.mode === "list"
      ? cuda.ids.flatMap((id) => {
          const pool = allGpu.find((candidate) => candidate.deviceRef === id);
          return pool ? [pool] : [];
        })
      : cuda.mode === "none" || deviceDisablesGpu
        ? []
        : allGpu;
  const selectedGpu =
    explicitCuda.length > 0
      ? explicitCuda.flatMap((index) => visibleGpu[index] ?? [])
      : visibleGpu;
  const gpuOrder = new Map(
    selectedGpu.map((pool, index) => [pool.id, index] as const),
  );

  return allPools.flatMap((pool) => {
    if (pool.kind === "gpu" && !gpuOrder.has(pool.id)) {
      return [];
    }
    const deviceIndex =
      pool.kind === "gpu"
        ? (gpuOrder.get(pool.id) ?? null)
        : pool.deviceRef !== null && Number.isFinite(Number(pool.deviceRef))
          ? Number(pool.deviceRef)
          : null;
    return [{ id: pool.id, kind: pool.kind, deviceIndex }];
  });
}

export type MemoryEstimateContext = {
  kind: InstanceKind;
  binaryPath: string;
  binaryPathRefId: string;
  args: MemoryEstimateArgs;
  env: Record<string, string>;
  positionalArgs: string[];
};

export function resolveMemoryEstimateContext(
  request: MemoryEstimateRequest,
): MemoryEstimateContext | { error: string } {
  let args: MemoryEstimateArgs = {};
  let kind: InstanceKind = request.kind ?? "llama-server";
  let env = request.env ?? {};
  let positionalArgs = request.positionalArgs ?? [];
  let binaryPathRefId = request.binaryPathRefId ?? "";
  let binaryPath = binaryPathRefId
    ? (getPathCatalogEntry(binaryPathRefId)?.path ?? "")
    : "";
  if (request.instanceId) {
    const instance = getInstance(request.instanceId);
    if (!instance) {
      return { error: `instance not found: ${request.instanceId}` };
    }
    kind = instance.kind;
    env = instance.env;
    positionalArgs = instance.positionalArgs ?? [];
    args = { ...(instance.args as InstanceArgs) };
    binaryPath = instance.binaryPath;
    binaryPathRefId = instance.binaryPathRefId;
  }
  if (request.args) {
    args = { ...args, ...request.args };
  }
  return {
    kind,
    binaryPath,
    binaryPathRefId,
    args,
    env,
    positionalArgs,
  };
}

function resolveExistingPath(
  args: MemoryEstimateArgs,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && existsSync(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

function resolveModelPath(args: MemoryEstimateArgs): string | null {
  return resolveExistingPath(args, ["--model", "-m"]);
}

function estimateVllmGpuUtil(input: {
  args: MemoryEstimateArgs;
  env: Record<string, string>;
  model: string;
}): MemoryEstimateResolution {
  if (argString(input.args, ["--device"])?.toLowerCase() === "cpu") {
    return {
      ok: false,
      reason:
        "vLLM CPU memory remains manual; the GPU utilization estimator is not applicable.",
    };
  }
  const utilization = argNumber(input.args, ["--gpu-memory-utilization"]);
  if (utilization === null) {
    return {
      ok: false,
      reason:
        "Set --gpu-memory-utilization explicitly before estimating; the vLLM default depends on the installed version.",
    };
  }
  if (utilization <= 0 || utilization > 1) {
    return {
      ok: false,
      reason: "--gpu-memory-utilization must be greater than 0 and at most 1",
    };
  }
  const tensorParallel = Math.max(
    1,
    Math.floor(argNumber(input.args, ["--tensor-parallel-size", "-tp"]) ?? 1),
  );
  const allGpu = listMemoryPools()
    .filter((pool) => pool.kind === "gpu")
    .sort(
      (left, right) =>
        Number(left.deviceRef ?? Number.MAX_SAFE_INTEGER) -
        Number(right.deviceRef ?? Number.MAX_SAFE_INTEGER),
    );
  const cuda = parseCudaVisibleDevices(input.env.CUDA_VISIBLE_DEVICES);
  if (cuda.mode === "none") {
    return { ok: false, reason: "CUDA_VISIBLE_DEVICES disables every GPU" };
  }
  const visible =
    cuda.mode === "list"
      ? cuda.ids.flatMap((id) => {
          const pool = allGpu.find((candidate) => candidate.deviceRef === id);
          return pool ? [pool] : [];
        })
      : allGpu;
  const selected = visible.slice(0, tensorParallel);
  if (selected.length === 0) {
    return { ok: false, reason: "No GPU memory pools are available for vLLM" };
  }
  const pools = selected.map((pool) => {
    const totalBytes = Math.round(pool.capacityBytes * utilization);
    return {
      poolId: pool.id,
      kind: "gpu" as const,
      weightsBytes: 0,
      kvBytes: 0,
      computeBytes: 0,
      overheadBytes: totalBytes,
      totalBytes,
    };
  });
  const totalBytes = pools.reduce((sum, pool) => sum + pool.totalBytes, 0);
  const maxModelLen = Math.max(
    0,
    Math.floor(argNumber(input.args, ["--max-model-len"]) ?? 0),
  );
  const warnings = [
    "vLLM reserves a utilization fraction of each selected GPU; host RAM is not estimated and remains manual.",
    ...(selected.length < tensorParallel
      ? [
          `Tensor parallel size is ${tensorParallel}, but only ${selected.length} matching GPU pool(s) exist.`,
        ]
      : []),
  ];
  return {
    ok: true,
    modelPath: input.model,
    estimate: MemoryEstimateSchema.parse({
      draws: pools.map((pool) => ({
        poolId: pool.poolId,
        bytes: pool.totalBytes,
      })),
      pools,
      weightsBytesTotal: 0,
      kvBytesTotal: 0,
      computeBytesTotal: 0,
      overheadBytesTotal: totalBytes,
      mmprojBytesTotal: 0,
      draftBytesTotal: 0,
      totalBytes,
      context: {
        nCtx: maxModelLen,
        nCtxSeq: maxModelLen,
        nBatch: 0,
        nUbatch: 0,
        nSeqMax: 1,
        kvUnified: true,
        flashAttn: false,
        typeK: "managed-by-vllm",
        typeV: "managed-by-vllm",
        offloadKqv: true,
        nGpuLayers: 0,
      },
      confidence: "high",
      warnings,
    }),
  };
}

function hasArg(args: MemoryEstimateArgs, key: string): boolean {
  const value = args[key];
  return value !== undefined && value !== null && value !== "";
}

function hparamsFromGguf(modelPath: string): MemoryEstimateHparams {
  const metadata = readGgufMetadata(modelPath);
  return {
    architecture: metadata.architecture,
    blockCount: metadata.blockCount,
    embeddingLength: metadata.embeddingLength,
    headCount: metadata.headCount,
    headCountKv: metadata.headCountKv,
    attentionKeyLength: metadata.attentionKeyLength,
    attentionValueLength: metadata.attentionValueLength,
    attentionKeyLengthMla: metadata.attentionKeyLengthMla,
    attentionValueLengthMla: metadata.attentionValueLengthMla,
    causalAttention: metadata.causalAttention,
    contextLength: metadata.contextLength,
    slidingWindow: metadata.slidingWindow,
    slidingWindowPattern: metadata.slidingWindowPattern,
    sharedKvLayers: metadata.sharedKvLayers,
    ssmConvKernel: metadata.ssmConvKernel,
    ssmGroupCount: metadata.ssmGroupCount,
    ssmInnerSize: metadata.ssmInnerSize,
    ssmStateSize: metadata.ssmStateSize,
    wkvHeadSize: metadata.wkvHeadSize,
    tokenShiftCount: metadata.tokenShiftCount,
    vocabularySize: metadata.vocabularySize,
  };
}

export function estimateMemory(
  request: MemoryEstimateRequest,
): MemoryEstimateResolution {
  const context = resolveMemoryEstimateContext(request);
  if ("error" in context) {
    return { ok: false, reason: context.error };
  }
  const { args, kind, env, positionalArgs } = context;

  const estimator = engineDescriptor(kind).estimator;
  if (estimator === "vllm-gpu-util") {
    const model = positionalArgs.find((item) => item.trim())?.trim();
    if (!model)
      return { ok: false, reason: "No vLLM model positional is configured." };
    return estimateVllmGpuUtil({ args, env, model });
  }
  if (estimator !== "gguf") {
    return {
      ok: false,
      reason: `memory estimate is not applicable to ${kind} instances`,
    };
  }

  const modelPath = resolveModelPath(args);
  if (!modelPath) {
    if (hasArg(args, "--models-preset")) {
      return {
        ok: false,
        reason:
          "Router instances (--models-preset) are not a single model; a per-model estimate is unavailable.",
      };
    }
    if (hasArg(args, "--hf-repo") || hasArg(args, "--model-url")) {
      return {
        ok: false,
        reason:
          "Remote models (--hf-repo/--model-url) are not supported yet; download the GGUF and set --model to estimate.",
      };
    }
    if (hasArg(args, "--model")) {
      return {
        ok: false,
        reason: `Model file not found: ${String(args["--model"])}`,
      };
    }
    return { ok: false, reason: "No --model is configured." };
  }

  const mmprojPath = resolveExistingPath(args, ["--mmproj"]);
  const draftPath = resolveExistingPath(args, [
    "--spec-draft-model",
    "-md",
    "--model-draft",
  ]);

  let estimate: MemoryEstimate;
  try {
    estimate = estimateInstanceMemory({
      tensors: readGgufModelTensorTable(modelPath),
      hparams: hparamsFromGguf(modelPath),
      args,
      pools: poolsForEstimate(args, env),
      ...(mmprojPath
        ? { mmproj: { tensors: readGgufModelTensorTable(mmprojPath) } }
        : {}),
      ...(draftPath
        ? {
            draft: {
              tensors: readGgufModelTensorTable(draftPath),
              hparams: hparamsFromGguf(draftPath),
            },
          }
        : {}),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to read GGUF: ${(error as Error).message}`,
    };
  }

  return { ok: true, modelPath, estimate };
}
