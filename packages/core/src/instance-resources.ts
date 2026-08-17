import { z } from "zod";

import {
  engineDescriptor,
  type EngineResourceProfileId,
  type InstanceKind,
} from "./engine-descriptor.js";

export type LlamaArgValue = string | number | boolean | string[] | null;
export type LlamaArgRecord = Record<string, LlamaArgValue>;

export function argRaw(
  args: LlamaArgRecord,
  keys: string[],
): LlamaArgValue | undefined {
  for (const key of keys) {
    if (key in args) {
      const value = args[key];
      if (value !== null && value !== "" && value !== false) {
        return value;
      }
    }
  }
  return undefined;
}

export const SGLANG_TENSOR_PARALLEL_KEYS = [
  "--tp-size",
  "--tensor-parallel-size",
  "--tp",
];

export const VLLM_TENSOR_PARALLEL_KEYS = ["--tensor-parallel-size", "-tp"];

export function argNumber(args: LlamaArgRecord, keys: string[]): number | null {
  const value = argRaw(args, keys);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function argString(args: LlamaArgRecord, keys: string[]): string | null {
  const value = argRaw(args, keys);
  if (typeof value === "string") {
    return value.trim();
  }
  return null;
}

export function argFlag(args: LlamaArgRecord, keys: string[]): boolean | null {
  const value = argRaw(args, keys);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["on", "true", "1", "yes", "enabled"].includes(normalized)) {
      return true;
    }
    if (["off", "false", "0", "no", "disabled"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

export function argPairedFlag(
  args: LlamaArgRecord,
  positiveKeys: string[],
  negativeKeys: string[],
  defaultValue: boolean,
): boolean {
  const positive = argFlag(args, positiveKeys);
  if (positive !== null) {
    return positive;
  }
  const negative = argFlag(args, negativeKeys);
  return negative === null ? defaultValue : !negative;
}

export function splitCsvItems(input: string): string[] {
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
}

export type GpuLayersRequest = {
  kind: "none" | "all" | "count";
  count: number;
};

export const GPU_LAYERS_ARG_KEYS = ["--n-gpu-layers", "-ngl", "--gpu-layers"];

export const ASSUMED_GPU_LAYERS_DEFAULT = "auto";

export function effectiveGpuLayersRaw(
  args: LlamaArgRecord,
  keys: string[],
  binaryDefault: string | null,
): LlamaArgValue {
  return argRaw(args, keys) ?? binaryDefault ?? ASSUMED_GPU_LAYERS_DEFAULT;
}

export function parseGpuLayersRequest(args: LlamaArgRecord): GpuLayersRequest {
  const raw = argRaw(args, GPU_LAYERS_ARG_KEYS);
  if (raw === undefined) {
    return { kind: "none", count: 0 };
  }
  return parseGpuLayersValue(raw);
}

function parseGpuLayersValue(raw: LlamaArgValue): GpuLayersRequest {
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "all" || normalized === "max" || normalized === "auto") {
      return { kind: "all", count: 0 };
    }
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return { kind: "none", count: 0 };
  }
  if (value < 0) {
    return { kind: "all", count: 0 };
  }
  return { kind: "count", count: value };
}

export function resolveGpuLayersValue(
  raw: LlamaArgValue,
  blockCount: number | null,
): number {
  return gpuLayersFromRequest(parseGpuLayersValue(raw), blockCount);
}

function gpuLayersFromRequest(
  request: GpuLayersRequest,
  blockCount: number | null,
): number {
  const layerAll = (blockCount ?? 0) + 1;
  if (request.kind === "none") {
    return 0;
  }
  if (request.kind === "all") {
    return layerAll;
  }
  return Math.min(request.count, layerAll);
}

export function parseCpuMoe(args: LlamaArgRecord): "all" | number | null {
  if (argFlag(args, ["--cpu-moe", "-cmoe"])) {
    return "all";
  }
  const count = argNumber(args, ["--n-cpu-moe", "-ncmoe"]);
  return count && count > 0 ? count : null;
}

export function expertOffloadLayerCount(
  args: LlamaArgRecord,
  layerAll: number,
): number {
  const moe = parseCpuMoe(args);
  if (moe === "all") {
    return layerAll;
  }
  if (typeof moe === "number") {
    return Math.min(moe, layerAll);
  }
  return 0;
}

export function parseTensorSplit(
  args: LlamaArgRecord,
  gpuCount: number,
): number[] {
  const raw = argString(args, ["--tensor-split", "-ts"]);
  if (!raw) {
    return Array.from({ length: gpuCount }, () => 1);
  }
  const parts = raw
    .split(/[,;/]/)
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (parts.length === 0) {
    return Array.from({ length: gpuCount }, () => 1);
  }
  const padded = Array.from(
    { length: gpuCount },
    (_unused, index) => parts[index] ?? 0,
  );
  return padded.some((value) => value > 0)
    ? padded
    : Array.from({ length: gpuCount }, () => 1);
}

export type CudaVisibleDevices = {
  mode: "all" | "none" | "list";
  ids: string[];
};

export function parseCudaVisibleDevices(
  value: string | undefined,
): CudaVisibleDevices {
  if (value === undefined) {
    return { mode: "all", ids: [] };
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-1") {
    return { mode: "none", ids: [] };
  }
  const ids = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return { mode: "none", ids: [] };
  }
  return { mode: "list", ids };
}

const CUDA_DEVICE_TOKEN = /^cuda(\d+)$/i;

export function isCudaDeviceToken(token: string): boolean {
  return CUDA_DEVICE_TOKEN.test(token);
}

export function parseDeviceTokens(args: LlamaArgRecord): string[] {
  const raw = argRaw(args, ["--device", "-dev"]);
  const text = Array.isArray(raw)
    ? raw.join(",")
    : raw === undefined || raw === null
      ? ""
      : String(raw);
  return text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function cudaTokenIndices(tokens: string[]): string[] {
  const indices: string[] = [];
  for (const token of tokens) {
    const match = CUDA_DEVICE_TOKEN.exec(token);
    if (match && match[1] !== undefined) {
      indices.push(match[1]);
    }
  }
  return indices;
}

export const InstanceResourcePlacementSchema = z.enum([
  "gpu",
  "hybrid",
  "cpu",
  "unknown",
]);
export type InstanceResourcePlacement = z.infer<
  typeof InstanceResourcePlacementSchema
>;

export const InstanceResourceGpuPoolSchema = z.object({
  poolId: z.string().nullable(),
  label: z.string(),
});
export type InstanceResourceGpuPool = z.infer<
  typeof InstanceResourceGpuPoolSchema
>;

export const InstanceResourceProfileConfidenceSchema = z.enum([
  "declared",
  "args+model",
  "args",
  "none",
]);

export const InstanceResourceProfileSourceSchema = z.enum([
  "declared-draws",
  "cuda-visible-devices",
  "device-arg",
  "n-gpu-layers",
  "binary-default",
  "tensor-split",
  "none",
]);

export const CudaVisibleDevicesSchema = z.object({
  mode: z.enum(["all", "none", "list"]),
  ids: z.array(z.string()),
});

export const InstanceResourceProfileSignalsSchema = z.object({
  source: InstanceResourceProfileSourceSchema,
  nGpuLayers: z.union([z.number().int(), z.literal("all")]).nullable(),
  nGpuLayersCoversModel: z.boolean().nullable(),
  gpuLayersDefault: z.string().nullable(),
  cpuMoe: z.union([z.number().int(), z.literal("all")]).nullable(),
  modelHasMoe: z.boolean().nullable(),
  cudaVisibleDevices: CudaVisibleDevicesSchema,
  deviceTokens: z.array(z.string()),
  tensorSplit: z.array(z.number()).nullable(),
});

export const InstanceResourceProfileSchema = z.object({
  placement: InstanceResourcePlacementSchema,
  gpuPools: z.array(InstanceResourceGpuPoolSchema),
  usesHost: z.boolean(),
  cpuReason: z.string().nullable(),
  confidence: InstanceResourceProfileConfidenceSchema,
  signals: InstanceResourceProfileSignalsSchema,
});
export type InstanceResourceProfile = z.infer<
  typeof InstanceResourceProfileSchema
>;
export type InstanceResourceProfileSignals = z.infer<
  typeof InstanceResourceProfileSignalsSchema
>;

export type InstanceResourceProfilePool = {
  id: string;
  kind: "gpu" | "host";
  deviceRef: string | null;
  name: string;
};

export type InstanceResourceProfileInput = {
  kind: InstanceKind;
  args: LlamaArgRecord;
  env: Record<string, string>;
  memory: Array<{ poolId: string; bytes: number }>;
  pools: InstanceResourceProfilePool[];
  model: { blockCount: number | null; expertCount: number | null } | null;
  gpuLayersDefault: string | null;
};

function poolKind(
  pools: InstanceResourceProfilePool[],
  id: string,
): "gpu" | "host" | null {
  return pools.find((pool) => pool.id === id)?.kind ?? null;
}

function poolLabel(pools: InstanceResourceProfilePool[], id: string): string {
  return pools.find((pool) => pool.id === id)?.name ?? id;
}

function gpuEntries(
  visible: InstanceResourceProfilePool[],
  cuda: CudaVisibleDevices,
  deviceTokens: string[],
  allGpu: InstanceResourceProfilePool[],
): InstanceResourceGpuPool[] {
  if (visible.length > 0) {
    return visible.map((pool) => ({ poolId: pool.id, label: pool.name }));
  }
  if (cuda.mode === "list" && cuda.ids.length > 0) {
    return cuda.ids.map((id) => ({ poolId: null, label: `gpu${id}` }));
  }
  const cudaIndices = cudaTokenIndices(deviceTokens);
  if (cudaIndices.length > 0) {
    return cudaIndices.map((id) => ({ poolId: null, label: `CUDA${id}` }));
  }
  if (allGpu.length === 0) {
    return [{ poolId: null, label: "GPU" }];
  }
  return allGpu.map((pool) => ({ poolId: pool.id, label: pool.name }));
}

type ResourceProfileContext = {
  input: InstanceResourceProfileInput;
  allGpu: InstanceResourceProfilePool[];
  cuda: CudaVisibleDevices;
  deviceTokens: string[];
  tensorSplit: number[] | null;
  gpuRequest: GpuLayersRequest;
  gpuRequestFromBinaryDefault: boolean;
  cpuMoe: "all" | number | null;
  blockCount: number | null;
  modelHasMoe: boolean | null;
  baseSignals: Omit<InstanceResourceProfileSignals, "source">;
  gpuDraws: InstanceResourceProfileInput["memory"];
  hostDraw: boolean;
};

function resourceProfileContext(
  input: InstanceResourceProfileInput,
): ResourceProfileContext {
  const allGpu = input.pools.filter((pool) => pool.kind === "gpu");
  const cuda = parseCudaVisibleDevices(input.env["CUDA_VISIBLE_DEVICES"]);
  const deviceTokens = parseDeviceTokens(input.args);
  const tensorSplit = argString(input.args, ["--tensor-split", "-ts"])
    ? parseTensorSplit(input.args, Math.max(allGpu.length, 1))
    : null;
  const configuredGpuRequest = parseGpuLayersRequest(input.args);
  const defaultGpuRequest =
    configuredGpuRequest.kind === "none" && allGpu.length > 0
      ? parseGpuLayersValue(
          input.gpuLayersDefault ?? ASSUMED_GPU_LAYERS_DEFAULT,
        )
      : null;
  const gpuRequestFromBinaryDefault =
    defaultGpuRequest !== null &&
    (defaultGpuRequest.kind === "all" ||
      (defaultGpuRequest.kind === "count" && defaultGpuRequest.count > 0));
  const gpuRequest =
    gpuRequestFromBinaryDefault && defaultGpuRequest !== null
      ? defaultGpuRequest
      : configuredGpuRequest;
  const cpuMoe = parseCpuMoe(input.args);
  const blockCount = input.model?.blockCount ?? null;
  const expertCount = input.model?.expertCount ?? null;
  const modelHasMoe = expertCount === null ? null : expertCount > 1;

  const baseSignals: Omit<InstanceResourceProfileSignals, "source"> = {
    nGpuLayers:
      gpuRequest.kind === "all"
        ? "all"
        : gpuRequest.kind === "count"
          ? gpuRequest.count
          : null,
    nGpuLayersCoversModel: null,
    gpuLayersDefault: input.gpuLayersDefault,
    cpuMoe,
    modelHasMoe,
    cudaVisibleDevices: cuda,
    deviceTokens,
    tensorSplit,
  };

  const gpuDraws = input.memory.filter(
    (draw) => poolKind(input.pools, draw.poolId) === "gpu" && draw.bytes > 0,
  );
  const hostDraw = input.memory.some(
    (draw) => poolKind(input.pools, draw.poolId) === "host" && draw.bytes > 0,
  );

  return {
    input,
    allGpu,
    cuda,
    deviceTokens,
    tensorSplit,
    gpuRequest,
    gpuRequestFromBinaryDefault,
    cpuMoe,
    blockCount,
    modelHasMoe,
    baseSignals,
    gpuDraws,
    hostDraw,
  };
}

function visibleGpuPools(
  allGpu: InstanceResourceProfilePool[],
  cuda: CudaVisibleDevices,
): InstanceResourceProfilePool[] {
  return cuda.mode === "list"
    ? cuda.ids.flatMap((id) => {
        const pool = allGpu.find((candidate) => candidate.deviceRef === id);
        return pool ? [pool] : [];
      })
    : allGpu;
}

function declaredGpuPools(
  context: ResourceProfileContext,
): InstanceResourceGpuPool[] {
  return context.gpuDraws.map((draw) => ({
    poolId: draw.poolId,
    label: poolLabel(context.input.pools, draw.poolId),
  }));
}

function declaredDrawsProfile(
  context: ResourceProfileContext,
): InstanceResourceProfile | null {
  const { baseSignals, gpuDraws, hostDraw } = context;
  if (gpuDraws.length > 0) {
    return {
      placement: hostDraw ? "hybrid" : "gpu",
      gpuPools: declaredGpuPools(context),
      usesHost: hostDraw,
      cpuReason: hostDraw ? "Host memory draw declared" : null,
      confidence: "declared",
      signals: { ...baseSignals, source: "declared-draws" },
    };
  }
  if (hostDraw) {
    return {
      placement: "cpu",
      gpuPools: [],
      usesHost: true,
      cpuReason: "Host-only memory draw declared",
      confidence: "declared",
      signals: { ...baseSignals, source: "declared-draws" },
    };
  }
  return null;
}

function deriveKtransformersHybridProfile(
  context: ResourceProfileContext,
): InstanceResourceProfile {
  const { input, allGpu, cuda, deviceTokens, baseSignals, gpuDraws, hostDraw } =
    context;
  const tensorParallel = Math.max(
    1,
    Math.floor(argNumber(input.args, SGLANG_TENSOR_PARALLEL_KEYS) ?? 1),
  );
  const visible = visibleGpuPools(allGpu, cuda);
  const selected = gpuEntries(
    visible.slice(0, tensorParallel),
    cuda,
    deviceTokens,
    allGpu,
  ).slice(0, tensorParallel);
  return {
    placement: "hybrid",
    gpuPools: gpuDraws.length > 0 ? declaredGpuPools(context) : selected,
    usesHost: true,
    cpuReason: "KTransformers keeps expert weights and CPU workers on host",
    confidence: gpuDraws.length > 0 && hostDraw ? "declared" : "args",
    signals: {
      ...baseSignals,
      source:
        gpuDraws.length > 0 || hostDraw
          ? "declared-draws"
          : cuda.mode === "list"
            ? "cuda-visible-devices"
            : "device-arg",
    },
  };
}

function deriveRpcDeviceArgsProfile(
  context: ResourceProfileContext,
): InstanceResourceProfile {
  const { allGpu, deviceTokens, baseSignals } = context;
  const cudaIndices = cudaTokenIndices(deviceTokens);
  if (cudaIndices.length > 0) {
    const visible = allGpu.filter(
      (pool) => pool.deviceRef !== null && cudaIndices.includes(pool.deviceRef),
    );
    return {
      placement: "gpu",
      gpuPools: gpuEntries(
        visible,
        { mode: "list", ids: cudaIndices },
        deviceTokens,
        allGpu,
      ),
      usesHost: false,
      cpuReason: null,
      confidence: "args",
      signals: { ...baseSignals, source: "device-arg" },
    };
  }
  if (deviceTokens.some((token) => token.toLowerCase() === "cpu")) {
    return {
      placement: "cpu",
      gpuPools: [],
      usesHost: true,
      cpuReason: "RPC worker on CPU backend",
      confidence: "args",
      signals: { ...baseSignals, source: "device-arg" },
    };
  }
  return {
    placement: "unknown",
    gpuPools: [],
    usesHost: false,
    cpuReason: null,
    confidence: "none",
    signals: { ...baseSignals, source: "none" },
  };
}

function deriveVllmArgsProfile(
  context: ResourceProfileContext,
): InstanceResourceProfile {
  const { input, allGpu, cuda, deviceTokens, baseSignals } = context;
  const cpu =
    cuda.mode === "none" ||
    deviceTokens.some((token) => token.toLowerCase() === "cpu");
  if (cpu) {
    return {
      placement: "cpu",
      gpuPools: [],
      usesHost: true,
      cpuReason:
        cuda.mode === "none"
          ? "GPU disabled (CUDA_VISIBLE_DEVICES)"
          : "vLLM CPU device selected",
      confidence: "args",
      signals: {
        ...baseSignals,
        source: cuda.mode === "none" ? "cuda-visible-devices" : "device-arg",
      },
    };
  }
  const visible = visibleGpuPools(allGpu, cuda);
  const tensorParallel = Math.max(
    1,
    Math.floor(argNumber(input.args, VLLM_TENSOR_PARALLEL_KEYS) ?? 1),
  );
  return {
    placement: "gpu",
    gpuPools: gpuEntries(
      visible.slice(0, tensorParallel),
      cuda,
      deviceTokens,
      allGpu,
    ).slice(0, tensorParallel),
    usesHost: false,
    cpuReason: null,
    confidence: "args",
    signals: {
      ...baseSignals,
      source: cuda.mode === "list" ? "cuda-visible-devices" : "device-arg",
    },
  };
}

const withDeclaredDraws =
  (derive: (context: ResourceProfileContext) => InstanceResourceProfile) =>
  (context: ResourceProfileContext): InstanceResourceProfile =>
    declaredDrawsProfile(context) ?? derive(context);

const RESOURCE_PROFILE_DERIVERS: Record<
  EngineResourceProfileId,
  (context: ResourceProfileContext) => InstanceResourceProfile
> = {
  "llama-args": withDeclaredDraws(deriveLlamaArgsProfile),
  "rpc-device-args": withDeclaredDraws(deriveRpcDeviceArgsProfile),
  "vllm-args": withDeclaredDraws(deriveVllmArgsProfile),
  "ktransformers-hybrid": deriveKtransformersHybridProfile,
};

export function deriveInstanceResourceProfile(
  input: InstanceResourceProfileInput,
): InstanceResourceProfile {
  const deriver =
    RESOURCE_PROFILE_DERIVERS[engineDescriptor(input.kind).resourceProfile];
  return deriver(resourceProfileContext(input));
}

function deriveLlamaArgsProfile(
  context: ResourceProfileContext,
): InstanceResourceProfile {
  const {
    input,
    allGpu,
    cuda,
    deviceTokens,
    tensorSplit,
    gpuRequest,
    gpuRequestFromBinaryDefault,
    cpuMoe,
    blockCount,
    modelHasMoe,
    baseSignals,
  } = context;

  if (cuda.mode === "none") {
    return {
      placement: "cpu",
      gpuPools: [],
      usesHost: true,
      cpuReason: "GPU disabled (CUDA_VISIBLE_DEVICES)",
      confidence: blockCount !== null ? "args+model" : "args",
      signals: { ...baseSignals, source: "cuda-visible-devices" },
    };
  }

  const offloads =
    gpuRequest.kind === "all" ||
    (gpuRequest.kind === "count" && gpuRequest.count > 0);
  if (!offloads) {
    const cpuReason =
      gpuRequest.kind === "count"
        ? "No GPU offload (-ngl 0)"
        : "No GPU offload configured";
    return {
      placement: "cpu",
      gpuPools: [],
      usesHost: true,
      cpuReason,
      confidence: blockCount !== null ? "args+model" : "args",
      signals: {
        ...baseSignals,
        source: gpuRequest.kind === "none" ? "none" : "n-gpu-layers",
      },
    };
  }

  const cudaIndices = cudaTokenIndices(deviceTokens);
  let visible =
    cuda.mode === "list"
      ? allGpu.filter(
          (pool) =>
            pool.deviceRef !== null && cuda.ids.includes(pool.deviceRef),
        )
      : allGpu;
  if (cudaIndices.length > 0) {
    visible = visible.filter(
      (pool) => pool.deviceRef !== null && cudaIndices.includes(pool.deviceRef),
    );
  }
  if (tensorSplit && visible.length > 0) {
    const restricted = visible.filter(
      (_pool, index) => (tensorSplit[index] ?? 0) > 0,
    );
    if (restricted.length > 0) {
      visible = restricted;
    }
  }
  const entries = gpuEntries(visible, cuda, deviceTokens, allGpu);
  const source: InstanceResourceProfileSignals["source"] = tensorSplit
    ? "tensor-split"
    : gpuRequestFromBinaryDefault
      ? "binary-default"
      : "n-gpu-layers";

  if (blockCount !== null) {
    const layerAll = blockCount + 1;
    const gpuLayers = gpuLayersFromRequest(gpuRequest, blockCount);
    const fullOffload = gpuLayers >= layerAll;
    const expertHostLayers = expertOffloadLayerCount(input.args, layerAll);
    const moeOnHost = (modelHasMoe ?? false) && expertHostLayers > 0;
    let placement: InstanceResourcePlacement;
    let usesHost: boolean;
    let cpuReason: string | null;
    if (fullOffload && !moeOnHost) {
      placement = "gpu";
      usesHost = false;
      cpuReason = null;
    } else if (fullOffload && moeOnHost) {
      placement = "hybrid";
      usesHost = true;
      cpuReason = "MoE experts on host (--cpu-moe)";
    } else {
      placement = "hybrid";
      usesHost = true;
      cpuReason = `${layerAll - gpuLayers} of ${layerAll} layers on host`;
    }
    return {
      placement,
      gpuPools: entries,
      usesHost,
      cpuReason,
      confidence: "args+model",
      signals: { ...baseSignals, source, nGpuLayersCoversModel: fullOffload },
    };
  }

  let placement: InstanceResourcePlacement;
  let usesHost: boolean;
  let cpuReason: string | null;
  if (cpuMoe !== null) {
    placement = "hybrid";
    usesHost = true;
    cpuReason = "MoE experts on host (--cpu-moe)";
  } else if (gpuRequest.kind === "all") {
    placement = "gpu";
    usesHost = false;
    cpuReason = null;
  } else {
    placement = "hybrid";
    usesHost = true;
    cpuReason = "Partial GPU offload (model layers unknown)";
  }
  return {
    placement,
    gpuPools: entries,
    usesHost,
    cpuReason,
    confidence: "args",
    signals: { ...baseSignals, source },
  };
}
