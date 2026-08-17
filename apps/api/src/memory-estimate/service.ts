import {
  engineDescriptor,
  estimateInstanceMemory,
  argFlag,
  argNumber,
  argPairedFlag,
  argRaw,
  argString,
  cudaTokenIndices,
  isCudaDeviceToken,
  parseCudaVisibleDevices,
  parseDeviceTokens,
  splitCsvItems,
  MemoryEstimateSchema,
  VLLM_TENSOR_PARALLEL_KEYS,
  type CudaVisibleDevices,
  type EngineEstimatorId,
  type Instance,
  type InstanceArgs,
  type InstanceEngineConfig,
  type MemoryEstimate,
  type MemoryEstimateArgs,
  type MemoryEstimatePoolInput,
  type MemoryEstimateRequest,
  type InstanceKind,
  type RpcWorkerRef,
} from "@arriero/core";
import { existsSync, statSync } from "node:fs";

import { getInstance } from "../instances/repository.js";
import { cachedGpuLayersDefaults } from "../arguments/binary-defaults.js";
import { loadArgumentRegistry } from "../arguments/registry.js";
import {
  REMOVED_LLAMA_ARGUMENT_GROUPS,
  type LlamaArgumentEstimation,
} from "../arguments/estimation.js";
import { loadGgufHparams, loadGgufTensorTable } from "../models/gguf-cache.js";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import { listMemoryPools } from "../resources/repository.js";

export type MemoryEstimateResolution =
  | {
      ok: true;
      modelPath: string;
      estimate: MemoryEstimate;
      context: MemoryEstimateContext;
    }
  | { ok: false; reason: string };

function cudaVisibleGpuPools(cuda: CudaVisibleDevices) {
  const allGpu = listMemoryPools()
    .filter((pool) => pool.kind === "gpu")
    .sort(
      (left, right) =>
        Number(left.deviceRef ?? Number.MAX_SAFE_INTEGER) -
        Number(right.deviceRef ?? Number.MAX_SAFE_INTEGER),
    );
  if (cuda.mode !== "list") {
    return allGpu;
  }
  return cuda.ids.flatMap((id) => {
    const pool = allGpu.find((candidate) => candidate.deviceRef === id);
    return pool ? [pool] : [];
  });
}

export function poolsForEstimate(
  args: MemoryEstimateArgs,
  env: Record<string, string>,
): MemoryEstimatePoolInput[] {
  const cuda = parseCudaVisibleDevices(env.CUDA_VISIBLE_DEVICES);
  const deviceTokens = parseDeviceTokens(args);
  const explicitCuda = cudaTokenIndices(deviceTokens).map(Number);
  const deviceDisablesGpu = deviceTokens.some(
    (token) => token.toLowerCase() === "none",
  );
  const deviceWasSet = hasArg(args, "--device") || hasArg(args, "-dev");
  const allPools = listMemoryPools();
  const visibleGpu =
    cuda.mode === "none" ||
    deviceDisablesGpu ||
    (deviceWasSet && explicitCuda.length === 0)
      ? []
      : cudaVisibleGpuPools(cuda);
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
  rpcWorkers: RpcWorkerRef[];
  engineConfig?: InstanceEngineConfig;
};

export function resolveLlamaArgumentEnvironment(
  args: MemoryEstimateArgs,
  env: Record<string, string>,
): MemoryEstimateArgs {
  const resolved = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== false),
  ) as MemoryEstimateArgs;

  for (const { option } of loadArgumentRegistry()) {
    if (option.names.some((name) => hasArg(args, name))) {
      continue;
    }

    const negativeName = option.names.find((name) => /^--no-/.test(name));
    const hasPositiveName = option.names.some(
      (name) => /^--/.test(name) && !/^--no-/.test(name),
    );
    if (negativeName && hasPositiveName) {
      const negativeEnv = option.env.find((name) => {
        const compatibilityName = name.replace(/^LLAMA_ARG_/, "LLAMA_ARG_NO_");
        return Object.hasOwn(env, compatibilityName);
      });
      if (negativeEnv) {
        resolved[negativeName] = true;
        continue;
      }
    }

    const envName = option.env.find((name) => Object.hasOwn(env, name));
    if (envName) {
      resolved[option.primaryName] = env[envName]!;
    }
  }

  return resolved;
}

export function contextFromInstance(instance: Instance): MemoryEstimateContext {
  return {
    kind: instance.kind,
    binaryPath: instance.binaryPath,
    binaryPathRefId: instance.binaryPathRefId,
    args: { ...(instance.args as InstanceArgs) },
    env: instance.env,
    positionalArgs: instance.positionalArgs ?? [],
    rpcWorkers: instance.rpcWorkers,
    ...(instance.engineConfig ? { engineConfig: instance.engineConfig } : {}),
  };
}

function resolveMemoryEstimateContext(
  request: MemoryEstimateRequest,
): MemoryEstimateContext | { error: string } {
  let context: MemoryEstimateContext;
  if (request.instanceId) {
    const instance = getInstance(request.instanceId);
    if (!instance) {
      return { error: `instance not found: ${request.instanceId}` };
    }
    context = contextFromInstance(instance);
  } else {
    const binaryPathRefId = request.binaryPathRefId ?? "";
    context = {
      kind: request.kind ?? "llama-server",
      binaryPath: binaryPathRefId
        ? (getPathCatalogEntry(binaryPathRefId)?.path ?? "")
        : "",
      binaryPathRefId,
      args: {},
      env: request.env ?? {},
      positionalArgs: request.positionalArgs ?? [],
      rpcWorkers: request.rpcWorkers ?? [],
    };
  }
  if (request.args) {
    context.args = { ...context.args, ...request.args };
  }
  if (request.rpcWorkers) {
    context.rpcWorkers = request.rpcWorkers;
  }
  return context;
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

export function resolveModelPath(args: MemoryEstimateArgs): string | null {
  return resolveExistingPath(args, ["--model", "-m"]);
}

function stringArgItems(args: MemoryEstimateArgs, keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = args[key];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) =>
      typeof item === "string" ? splitCsvItems(item) : [],
    );
  });
}

function stripScaledPath(value: string): string {
  const separator = value.lastIndexOf(":");
  return separator > 0 ? value.slice(0, separator).trim() : value;
}

export function auxiliaryGgufPaths(args: MemoryEstimateArgs): {
  loraPaths: string[];
  controlVectorPaths: string[];
} {
  return {
    loraPaths: [
      ...stringArgItems(args, ["--lora"]),
      ...stringArgItems(args, ["--lora-scaled"]).map(stripScaledPath),
    ],
    controlVectorPaths: [
      ...stringArgItems(args, ["--control-vector"]),
      ...stringArgItems(args, ["--control-vector-scaled"]).map(stripScaledPath),
    ],
  };
}

function estimateVllmGpuUtil(input: {
  args: MemoryEstimateArgs;
  env: Record<string, string>;
  model: string;
}):
  | { ok: true; modelPath: string; estimate: MemoryEstimate }
  | { ok: false; reason: string } {
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
    Math.floor(argNumber(input.args, VLLM_TENSOR_PARALLEL_KEYS) ?? 1),
  );
  const cuda = parseCudaVisibleDevices(input.env.CUDA_VISIBLE_DEVICES);
  if (cuda.mode === "none") {
    return { ok: false, reason: "CUDA_VISIBLE_DEVICES disables every GPU" };
  }
  const selected = cudaVisibleGpuPools(cuda).slice(0, tensorParallel);
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
      loraBytesTotal: 0,
      controlVectorBytesTotal: 0,
      selfMtpBytesTotal: 0,
      totalBytes,
      context: {
        nCtx: maxModelLen,
        nCtxSeq: maxModelLen,
        nBatch: 0,
        nUbatch: 0,
        nSeqMax: 1,
        kvUnified: true,
        swaFull: false,
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
  return argRaw(args, [key]) !== undefined;
}

export const MMPROJ_ARG_KEYS = ["--mmproj", "-mm"];
export const DRAFT_MODEL_ARG_KEYS = [
  "--spec-draft-model",
  "-md",
  "--model-draft",
];

function configuredKey(
  args: MemoryEstimateArgs,
  keys: readonly string[],
): string | null {
  return keys.find((key) => hasArg(args, key)) ?? null;
}

function estimationOptions(estimation: LlamaArgumentEstimation): string[][] {
  return loadArgumentRegistry()
    .filter((entry) => entry.estimation === estimation)
    .map((entry) => entry.option.names);
}

function configuredEstimationArgument(
  args: MemoryEstimateArgs,
  estimation: LlamaArgumentEstimation,
): string | null {
  return (
    estimationOptions(estimation)
      .map((names) => configuredKey(args, names))
      .find((key) => key !== null) ?? null
  );
}

function invalidNumericArgument(
  args: MemoryEstimateArgs,
  keys: string[],
  isInvalid: (value: number) => boolean,
  requirement: string,
): string | null {
  const key = configuredKey(args, keys);
  if (!key) return null;
  const value = argNumber(args, keys);
  if (value === null || isInvalid(value)) {
    return `${key} must be ${requirement} for the current llama-server`;
  }
  return null;
}

function invalidFlagStyleBooleanArgument(
  args: MemoryEstimateArgs,
): string | null {
  for (const { option } of loadArgumentRegistry()) {
    if (option.valueType !== "boolean" || option.allowedValues.length > 0) {
      continue;
    }
    for (const name of option.names) {
      if (hasArg(args, name) && args[name] !== true) {
        return name;
      }
    }
  }
  return null;
}

function estimateVllmModelMemory(
  context: MemoryEstimateContext,
  args: MemoryEstimateArgs,
): MemoryEstimateResolution {
  const model = context.positionalArgs.find((item) => item.trim())?.trim();
  if (!model) {
    return { ok: false, reason: "No vLLM model positional is configured." };
  }
  const result = estimateVllmGpuUtil({ args, env: context.env, model });
  return result.ok ? { ...result, context } : result;
}

const ENGINE_ESTIMATORS: Record<
  EngineEstimatorId,
  (
    context: MemoryEstimateContext,
    args: MemoryEstimateArgs,
  ) => MemoryEstimateResolution | Promise<MemoryEstimateResolution>
> = {
  gguf: estimateGgufMemory,
  "vllm-gpu-util": estimateVllmModelMemory,
  none: (context) => ({
    ok: false,
    reason: `memory estimate is not applicable to ${context.kind} instances`,
  }),
};

export async function estimateMemory(
  request: MemoryEstimateRequest,
): Promise<MemoryEstimateResolution> {
  const context = resolveMemoryEstimateContext(request);
  if ("error" in context) {
    return { ok: false, reason: context.error };
  }
  const { kind, env } = context;
  const invalidRawBoolean =
    kind === "llama-server"
      ? invalidFlagStyleBooleanArgument(context.args)
      : null;
  if (invalidRawBoolean) {
    return {
      ok: false,
      reason: `${invalidRawBoolean} is a flag-style boolean in the current llama-server. Arriero's argv launcher accepts true (emit the selected alias) or false (omit it); use the negative alias to disable it.`,
    };
  }
  const args =
    kind === "llama-server"
      ? resolveLlamaArgumentEnvironment(context.args, env)
      : context.args;
  return ENGINE_ESTIMATORS[engineDescriptor(kind).estimator](context, args);
}

async function estimateGgufMemory(
  context: MemoryEstimateContext,
  args: MemoryEstimateArgs,
): Promise<MemoryEstimateResolution> {
  const { env, rpcWorkers } = context;

  const removedArgument = REMOVED_LLAMA_ARGUMENT_GROUPS.map((keys) =>
    configuredKey(args, keys),
  ).find((key) => key !== null);
  if (removedArgument) {
    return {
      ok: false,
      reason: `${removedArgument} is a removed llama.cpp argument; the current llama-server exits during argument parsing instead of loading a model.`,
    };
  }

  const nonInferenceArgument = estimationOptions("exits")
    .map((names) =>
      argFlag(args, names) === true
        ? (configuredKey(args, names) ?? names[0])
        : null,
    )
    .find((key) => key != null);
  if (nonInferenceArgument) {
    return {
      ok: false,
      reason: `${nonInferenceArgument} makes the current llama-server print information and exit before loading a model.`,
    };
  }

  const invalidGeometry = [
    invalidNumericArgument(
      args,
      ["--ctx-size", "-c", "--context-size"],
      (value) => value < 0,
      "zero or a positive integer",
    ),
    invalidNumericArgument(
      args,
      ["--batch-size", "-b"],
      (value) => value <= 0,
      "a positive integer",
    ),
    invalidNumericArgument(
      args,
      ["--ubatch-size", "-ub"],
      (value) => value < 0,
      "zero or a positive integer",
    ),
    invalidNumericArgument(
      args,
      ["--parallel", "-np"],
      (value) => value === 0 || value > 256,
      "a negative auto value or an integer from 1 through 256",
    ),
  ].find((reason): reason is string => reason !== null);
  if (invalidGeometry) {
    return { ok: false, reason: invalidGeometry };
  }
  if (
    (argFlag(args, ["--embedding", "--embeddings"]) === true ||
      argFlag(args, ["--rerank", "--reranking"]) === true) &&
    argNumber(args, ["--ubatch-size", "-ub"]) === 0
  ) {
    return {
      ok: false,
      reason:
        "The current llama-server applies the embedding/rerank batch clamp before the --ubatch-size 0 library fallback, producing a zero batch and failing context creation; use an explicit positive ubatch.",
    };
  }

  const explicitDeviceTokens = parseDeviceTokens(args);
  const unsupportedDevices = explicitDeviceTokens.filter(
    (token) => !isCudaDeviceToken(token) && token.toLowerCase() !== "none",
  );
  if (unsupportedDevices.length > 0) {
    return {
      ok: false,
      reason: `Memory estimation currently maps local CUDA devices and --device none only; unsupported --device value(s): ${unsupportedDevices.join(", ")}.`,
    };
  }

  const estimatePools = poolsForEstimate(args, env);
  const requestedCudaDeviceCount = new Set(
    explicitDeviceTokens.filter(isCudaDeviceToken),
  ).size;
  const selectedGpuCount = estimatePools.filter(
    (pool) => pool.kind === "gpu",
  ).length;
  if (
    requestedCudaDeviceCount > 0 &&
    selectedGpuCount < requestedCudaDeviceCount
  ) {
    return {
      ok: false,
      reason:
        "One or more explicit CUDA devices do not map to configured memory pools after CUDA_VISIBLE_DEVICES is applied.",
    };
  }

  const splitMode = argString(args, ["--split-mode", "-sm"])?.toLowerCase();
  const mainGpu = argNumber(args, ["--main-gpu", "-mg"]);
  if (
    splitMode === "none" &&
    mainGpu !== null &&
    mainGpu >= 0 &&
    mainGpu >= selectedGpuCount &&
    selectedGpuCount > 0 &&
    rpcWorkers.length === 0 &&
    !hasArg(args, "--rpc")
  ) {
    return {
      ok: false,
      reason: `--main-gpu ${mainGpu} is outside the selected device list (${selectedGpuCount} device(s)).`,
    };
  }

  if (configuredEstimationArgument(args, "router")) {
    return {
      ok: false,
      reason:
        "Router instances (--models-preset/--models-dir) can load a changing set of child models; estimate each resolved child model separately.",
    };
  }

  if (configuredEstimationArgument(args, "preset-rewrite")) {
    return {
      ok: false,
      reason:
        "Built-in model presets rewrite the model, context, batch, slot, and sometimes draft/mmproj arguments inside llama.cpp; resolve the preset to local GGUF paths and explicit arguments before estimating.",
    };
  }

  if (configuredEstimationArgument(args, "remote-selector")) {
    return {
      ok: false,
      reason:
        "Remote model selectors (--hf-repo/--model-url/--docker-repo) can replace the local model and auto-discover mmproj/speculative sidecars; download the resolved artifacts and use explicit local paths before estimating.",
    };
  }

  const modelPath = resolveModelPath(args);
  if (!modelPath) {
    if (hasArg(args, "--model")) {
      return {
        ok: false,
        reason: `Model file not found: ${String(args["--model"])}`,
      };
    }
    return { ok: false, reason: "No --model is configured." };
  }
  if (statSync(modelPath, { throwIfNoEntry: false })?.isDirectory()) {
    return {
      ok: false,
      reason: `--model points at a directory (${modelPath}); the llama.cpp estimator needs a GGUF file, and safetensors directories are not estimable here.`,
    };
  }

  const mmprojDisabled = !argPairedFlag(
    args,
    ["--mmproj-auto"],
    ["--no-mmproj", "--no-mmproj-auto"],
    true,
  );
  const mmprojPath = mmprojDisabled
    ? null
    : resolveExistingPath(args, MMPROJ_ARG_KEYS);
  const draftPath = resolveExistingPath(args, DRAFT_MODEL_ARG_KEYS);
  if (!mmprojDisabled && configuredEstimationArgument(args, "remote-mmproj")) {
    return {
      ok: false,
      reason:
        "Remote multimodal projectors (--mmproj-url) are not supported yet; download the GGUF and set --mmproj to estimate it.",
    };
  }
  if (configuredEstimationArgument(args, "remote-draft")) {
    return {
      ok: false,
      reason:
        "Remote speculative draft models are not supported yet; download the resolved draft/sidecar GGUF and set --spec-draft-model.",
    };
  }
  const configuredMmprojKey = configuredKey(args, MMPROJ_ARG_KEYS);
  if (!mmprojDisabled && configuredMmprojKey && !mmprojPath) {
    return {
      ok: false,
      reason: `Multimodal projector GGUF file not found: ${String(
        args[configuredMmprojKey],
      )}`,
    };
  }
  const configuredDraftKey = configuredKey(args, DRAFT_MODEL_ARG_KEYS);
  if (configuredDraftKey && !draftPath) {
    return {
      ok: false,
      reason: `Speculative draft GGUF file not found: ${String(
        args[configuredDraftKey],
      )}`,
    };
  }
  const speculativeTypes = new Set(
    stringArgItems(args, ["--spec-type"]).map((value) => value.toLowerCase()),
  );
  const missingRequiredDraftType = [
    "draft-simple",
    "draft-eagle3",
    "draft-dflash",
    "draft-dspark",
  ].find((type) => speculativeTypes.has(type));
  if (missingRequiredDraftType && !draftPath) {
    return {
      ok: false,
      reason: `--spec-type ${missingRequiredDraftType} requires an explicit local --spec-draft-model after remote selectors are resolved.`,
    };
  }
  const auxiliaryPaths = auxiliaryGgufPaths(args);
  const missingAuxiliaryPath = [
    ...auxiliaryPaths.loraPaths,
    ...auxiliaryPaths.controlVectorPaths,
  ].find((path) => !existsSync(path));
  if (missingAuxiliaryPath) {
    return {
      ok: false,
      reason: `Auxiliary GGUF file not found: ${missingAuxiliaryPath}`,
    };
  }

  const gpuLayersDefaults = cachedGpuLayersDefaults(context.binaryPath);
  let estimate: MemoryEstimate;
  try {
    estimate = estimateInstanceMemory({
      tensors: await loadGgufTensorTable(modelPath),
      hparams: await loadGgufHparams(modelPath),
      args,
      pools: estimatePools,
      gpuLayersDefault: gpuLayersDefaults.main,
      ...(mmprojPath
        ? { mmproj: { tensors: await loadGgufTensorTable(mmprojPath) } }
        : {}),
      ...(draftPath
        ? {
            draft: {
              tensors: await loadGgufTensorTable(draftPath),
              hparams: await loadGgufHparams(draftPath),
              gpuLayersDefault: gpuLayersDefaults.draft,
            },
          }
        : {}),
      ...(auxiliaryPaths.loraPaths.length > 0
        ? {
            loras: await Promise.all(
              auxiliaryPaths.loraPaths.map(async (path) => ({
                tensors: await loadGgufTensorTable(path),
              })),
            ),
          }
        : {}),
      controlVector: auxiliaryPaths.controlVectorPaths.length > 0,
      rpcWorkerCount: rpcWorkers.length,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to estimate GGUF: ${(error as Error).message}`,
    };
  }

  return { ok: true, modelPath, estimate, context };
}
