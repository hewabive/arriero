import {
  engineDescriptor,
  estimateInstanceMemory,
  argFlag,
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
  type RpcWorkerRef,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { getInstance } from "../instances/repository.js";
import { loadArgumentRegistry } from "../arguments/registry.js";
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
  const deviceWasSet = hasArg(args, "--device") || hasArg(args, "-dev");
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
      : cuda.mode === "none" ||
          deviceDisablesGpu ||
          (deviceWasSet && explicitCuda.length === 0)
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
  rpcWorkers: RpcWorkerRef[];
};

/**
 * Apply llama.cpp's environment-variable layer before interpreting memory
 * arguments. The command line wins over the environment for every alias, just
 * as common_params_parse_ex() does. For a boolean option llama.cpp also accepts
 * a compatibility LLAMA_ARG_NO_* variable; its mere presence selects the
 * negative CLI form.
 *
 * The map comes from the synchronized current llama-server argument registry,
 * so model paths and future memory-affecting env aliases do not need a second
 * hand-maintained list here.
 */
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

export function resolveMemoryEstimateContext(
  request: MemoryEstimateRequest,
): MemoryEstimateContext | { error: string } {
  let args: MemoryEstimateArgs = {};
  let kind: InstanceKind = request.kind ?? "llama-server";
  let env = request.env ?? {};
  let positionalArgs = request.positionalArgs ?? [];
  let rpcWorkers = request.rpcWorkers ?? [];
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
    rpcWorkers = instance.rpcWorkers;
  }
  if (request.args) {
    args = { ...args, ...request.args };
  }
  if (request.rpcWorkers) {
    rpcWorkers = request.rpcWorkers;
  }
  return {
    kind,
    binaryPath,
    binaryPathRefId,
    args,
    env,
    positionalArgs,
    rpcWorkers,
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

function stringArgItems(args: MemoryEstimateArgs, keys: string[]): string[] {
  const splitCsv = (input: string): string[] => {
    const result: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character === '"') {
        if (quoted && input[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === "," && !quoted) {
        if (current.trim()) result.push(current.trim());
        current = "";
      } else {
        current += character;
      }
    }
    if (current.trim()) result.push(current.trim());
    return result;
  };
  return keys.flatMap((key) => {
    const value = args[key];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) =>
      typeof item === "string" ? splitCsv(item) : [],
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
  const value = args[key];
  return (
    value !== undefined && value !== null && value !== "" && value !== false
  );
}

const REMOVED_LLAMA_ARGUMENT_GROUPS = [
  ["--draft", "--draft-n", "--draft-max"],
  ["--draft-min", "--draft-n-min"],
  ["--spec-ngram-size-n"],
  ["--spec-ngram-size-m"],
  ["--spec-ngram-min-hits"],
] as const;

const NON_INFERENCE_LLAMA_ARGUMENT_GROUPS = [
  ["--help", "--usage", "-h"],
  ["--version"],
  ["--list-devices"],
  ["--cache-list", "-cl"],
  ["--completion-bash"],
] as const;

function configuredKey(
  args: MemoryEstimateArgs,
  keys: readonly string[],
): string | null {
  return keys.find((key) => hasArg(args, key)) ?? null;
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
    nextnPredictLayers: metadata.nextnPredictLayers,
    shortConvCacheLength: metadata.shortConvCacheLength,
    ssmConvKernel: metadata.ssmConvKernel,
    ssmGroupCount: metadata.ssmGroupCount,
    ssmInnerSize: metadata.ssmInnerSize,
    ssmStateSize: metadata.ssmStateSize,
    wkvHeadSize: metadata.wkvHeadSize,
    tokenShiftCount: metadata.tokenShiftCount,
    kdaHeadDim: metadata.kdaHeadDim,
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
  const { kind, env, positionalArgs, rpcWorkers } = context;
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

  const removedArgument = REMOVED_LLAMA_ARGUMENT_GROUPS.flatMap((keys) =>
    configuredKey(args, keys) ? [configuredKey(args, keys)!] : [],
  )[0];
  if (removedArgument) {
    return {
      ok: false,
      reason: `${removedArgument} is a removed llama.cpp argument; the current llama-server exits during argument parsing instead of loading a model.`,
    };
  }

  const nonInferenceArgument = NON_INFERENCE_LLAMA_ARGUMENT_GROUPS.flatMap(
    (keys) =>
      argFlag(args, [...keys]) === true
        ? [configuredKey(args, keys) ?? keys[0]]
        : [],
  )[0];
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
    (token) => !/^(?:cuda\d+|none)$/i.test(token),
  );
  if (unsupportedDevices.length > 0) {
    return {
      ok: false,
      reason: `Memory estimation currently maps local CUDA devices and --device none only; unsupported --device value(s): ${unsupportedDevices.join(", ")}.`,
    };
  }

  const estimatePools = poolsForEstimate(args, env);
  const requestedCudaDeviceCount = new Set(
    explicitDeviceTokens.filter((token) => /^cuda\d+$/i.test(token)),
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

  const routerArgs = ["--models-preset", "--models-dir"];
  if (routerArgs.some((key) => hasArg(args, key))) {
    return {
      ok: false,
      reason:
        "Router instances (--models-preset/--models-dir) can load a changing set of child models; estimate each resolved child model separately.",
    };
  }

  const presetArgs = [
    "--embd-gemma-default",
    "--fim-qwen-1.5b-default",
    "--fim-qwen-3b-default",
    "--fim-qwen-7b-default",
    "--fim-qwen-7b-spec",
    "--fim-qwen-14b-spec",
    "--fim-qwen-30b-default",
    "--gpt-oss-20b-default",
    "--gpt-oss-120b-default",
    "--vision-gemma-4b-default",
    "--vision-gemma-12b-default",
  ];
  if (presetArgs.some((key) => hasArg(args, key))) {
    return {
      ok: false,
      reason:
        "Built-in model presets rewrite the model, context, batch, slot, and sometimes draft/mmproj arguments inside llama.cpp; resolve the preset to local GGUF paths and explicit arguments before estimating.",
    };
  }

  const remoteMainArgs = [
    "--hf-repo",
    "-hf",
    "-hfr",
    "--model-url",
    "-mu",
    "--docker-repo",
    "-dr",
  ];
  if (remoteMainArgs.some((key) => hasArg(args, key))) {
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

  const mmprojKeys = ["--mmproj", "-mm"];
  const draftKeys = ["--spec-draft-model", "-md", "--model-draft"];
  const mmprojDisabled =
    argFlag(args, ["--no-mmproj", "--no-mmproj-auto"]) === true ||
    argFlag(args, ["--mmproj-auto"]) === false;
  const mmprojPath = mmprojDisabled
    ? null
    : resolveExistingPath(args, mmprojKeys);
  const draftPath = resolveExistingPath(args, draftKeys);
  if (
    !mmprojDisabled &&
    (hasArg(args, "--mmproj-url") || hasArg(args, "-mmu"))
  ) {
    return {
      ok: false,
      reason:
        "Remote multimodal projectors (--mmproj-url) are not supported yet; download the GGUF and set --mmproj to estimate it.",
    };
  }
  if (
    ["--spec-draft-hf", "-hfd", "-hfrd", "--hf-repo-draft"].some((key) =>
      hasArg(args, key),
    )
  ) {
    return {
      ok: false,
      reason:
        "Remote speculative draft models are not supported yet; download the resolved draft/sidecar GGUF and set --spec-draft-model.",
    };
  }
  if (
    !mmprojDisabled &&
    mmprojKeys.some((key) => hasArg(args, key)) &&
    !mmprojPath
  ) {
    return {
      ok: false,
      reason: `Multimodal projector GGUF file not found: ${String(
        args[mmprojKeys.find((key) => hasArg(args, key))!],
      )}`,
    };
  }
  if (draftKeys.some((key) => hasArg(args, key)) && !draftPath) {
    return {
      ok: false,
      reason: `Speculative draft GGUF file not found: ${String(
        args[draftKeys.find((key) => hasArg(args, key))!],
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

  let estimate: MemoryEstimate;
  try {
    estimate = estimateInstanceMemory({
      tensors: readGgufModelTensorTable(modelPath),
      hparams: hparamsFromGguf(modelPath),
      args,
      pools: estimatePools,
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
      ...(auxiliaryPaths.loraPaths.length > 0
        ? {
            loras: auxiliaryPaths.loraPaths.map((path) => ({
              tensors: readGgufModelTensorTable(path),
            })),
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

  return { ok: true, modelPath, estimate };
}
