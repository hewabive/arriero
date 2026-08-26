import type {
  Instance,
  KTransformersMethod,
  MemoryPool,
  NumaNode,
  ProcessPreflightIssue,
} from "@arriero/core";
import {
  ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY,
  isHfRepoId,
  parseCudaVisibleDevices,
  SGLANG_TENSOR_PARALLEL_KEYS,
} from "@arriero/core";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { getSystemResources } from "../system/resources.js";
import { formatGib } from "../utils/format.js";
import { numaIsApplicable, readNumaTopology } from "../numa/topology.js";
import { listMemoryPools } from "../resources/repository.js";
import { nvidiaGpuAccelerators } from "./preflight-cuda.js";
import {
  validateSglangArgumentCompatibility,
  validateSglangCuda,
  validateSglangManagedBoundary,
  validateSglangServingWarnings,
} from "./preflight-sglang.js";
import {
  configuredInstanceArg,
  instanceArgNumber,
  isExplicitPath,
  issue,
} from "./preflight-shared.js";
import type { PreflightOptions } from "./preflight.js";

function validateModel(model: string, issues: ProcessPreflightIssue[]) {
  if (existsSync(model)) {
    try {
      if (!statSync(model).isDirectory()) {
        issue(
          issues,
          "error",
          "engineConfig.model",
          "KTransformers local model must be a directory",
        );
      }
    } catch (error) {
      issue(
        issues,
        "error",
        "engineConfig.model",
        `Unable to inspect KTransformers model: ${(error as Error).message}`,
      );
    }
    return;
  }
  if (isExplicitPath(model)) {
    issue(
      issues,
      "error",
      "engineConfig.model",
      `KTransformers model path does not exist: ${model}`,
    );
    return;
  }
  if (!isHfRepoId(model)) {
    issue(
      issues,
      "error",
      "engineConfig.model",
      "KTransformers model must be an existing local path or owner/model Hugging Face id",
    );
  }
}

function validateCpuWeights(path: string, issues: ProcessPreflightIssue[]) {
  if (!existsSync(path)) {
    issue(
      issues,
      "error",
      "engineConfig.cpuWeights",
      `KTransformers CPU weights do not exist: ${path}`,
    );
    return;
  }
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      issue(
        issues,
        "error",
        "engineConfig.cpuWeights",
        "KTransformers CPU weights must be a directory for the supported package profile",
      );
    }
  } catch (error) {
    issue(
      issues,
      "error",
      "engineConfig.cpuWeights",
      `Unable to inspect KTransformers CPU weights: ${(error as Error).message}`,
    );
  }
}

type KTransformersRuntime = {
  pythonMinor: string;
  ktKernelVersion: string;
  sglangKtVersion: string;
};

type RuntimeProbeOutcome = {
  runtime: KTransformersRuntime | null;
  issues: ProcessPreflightIssue[];
  transient: boolean;
};

const execFileAsync = promisify(execFile);
const RUNTIME_PROBE_FAILURE_TTL_MS = 30_000;
const runtimeProbeCache = new Map<
  string,
  { outcome: RuntimeProbeOutcome; expiresAt: number | null }
>();
const runtimeProbesInFlight = new Map<string, Promise<RuntimeProbeOutcome>>();

function runtimeProbeCacheKey(python: string): string | null {
  try {
    return `${python}:${statSync(python).mtimeMs}`;
  } catch {
    return null;
  }
}

async function probeRuntime(
  python: string,
  timeoutMs: number,
): Promise<RuntimeProbeOutcome> {
  const probeIssues: ProcessPreflightIssue[] = [];
  let stdout: string;
  try {
    const result = await execFileAsync(
      python,
      [
        "-c",
        [
          "import importlib.metadata as metadata",
          "import json",
          "import sys",
          "import kt_kernel",
          "import sglang",
          "from kt_kernel import kt_kernel_ext",
          "cpu_infer = kt_kernel_ext.CPUInfer(1)",
          "del cpu_infer",
          "print('ARRIERO_KT_RUNTIME=' + json.dumps([f'{sys.version_info.major}.{sys.version_info.minor}', metadata.version('kt-kernel'), metadata.version('sglang-kt')]))",
        ].join("; "),
      ],
      { encoding: "utf8", timeout: timeoutMs },
    );
    stdout = result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
    issue(
      probeIssues,
      "error",
      "binaryPathRefId",
      timedOut
        ? `KTransformers runtime import probe timed out after ${timeoutMs} ms`
        : "KTransformers runtime import or CPU-kernel smoke test failed in the selected environment",
    );
    return { runtime: null, issues: probeIssues, transient: true };
  }
  const prefix = "ARRIERO_KT_RUNTIME=";
  const runtimeLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix));
  let runtimeValues: unknown = null;
  try {
    runtimeValues = runtimeLine
      ? (JSON.parse(runtimeLine.slice(prefix.length)) as unknown)
      : null;
  } catch {
    runtimeValues = null;
  }
  if (
    !Array.isArray(runtimeValues) ||
    runtimeValues.length !== 3 ||
    runtimeValues.some((value) => typeof value !== "string")
  ) {
    issue(
      probeIssues,
      "error",
      "binaryPathRefId",
      "KTransformers runtime did not report Python and root package versions",
    );
    return { runtime: null, issues: probeIssues, transient: false };
  }
  const [pythonMinor, ktKernelVersion, sglangKtVersion] = runtimeValues as [
    string,
    string,
    string,
  ];
  if (pythonMinor !== "3.11" && pythonMinor !== "3.12") {
    issue(
      probeIssues,
      "error",
      "binaryPathRefId",
      `KTransformers requires Python 3.11 or 3.12; selected environment reports ${pythonMinor || "unknown"}`,
    );
  }
  if (ktKernelVersion !== sglangKtVersion) {
    issue(
      probeIssues,
      "error",
      "binaryPathRefId",
      `KTransformers root package versions do not match: kt-kernel=${ktKernelVersion}, sglang-kt=${sglangKtVersion}`,
    );
  }
  return {
    runtime: { pythonMinor, ktKernelVersion, sglangKtVersion },
    issues: probeIssues,
    transient: false,
  };
}

async function probeRuntimeCached(
  python: string,
  timeoutMs: number,
): Promise<RuntimeProbeOutcome> {
  const key = runtimeProbeCacheKey(python);
  if (!key) {
    return probeRuntime(python, timeoutMs);
  }
  const cached = runtimeProbeCache.get(key);
  if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return cached.outcome;
  }
  const inFlight = runtimeProbesInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const probe = probeRuntime(python, timeoutMs)
    .then((outcome) => {
      runtimeProbeCache.set(key, {
        outcome,
        expiresAt: outcome.transient
          ? Date.now() + RUNTIME_PROBE_FAILURE_TTL_MS
          : null,
      });
      return outcome;
    })
    .finally(() => {
      runtimeProbesInFlight.delete(key);
    });
  runtimeProbesInFlight.set(key, probe);
  return probe;
}

async function validateRuntime(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
): Promise<KTransformersRuntime | null> {
  if (basename(instance.binaryPath) !== "sglang") {
    issue(
      issues,
      "error",
      "binaryPathRefId",
      "KTransformers requires the sglang entrypoint from a matched environment",
    );
  }
  const python = resolve(dirname(instance.binaryPath), "python");
  if (!existsSync(python)) {
    issue(
      issues,
      "error",
      "binaryPathRefId",
      `KTransformers environment Python is missing: ${python}`,
    );
    return null;
  }
  const timeoutMs = options.runtimeProbeTimeoutMs ?? 30_000;
  const outcome = await probeRuntimeCached(python, timeoutMs);
  issues.push(...outcome.issues);
  return outcome.runtime;
}

function argValues(instance: Instance, keys: string[]): string[] {
  for (const key of keys) {
    const value = instance.args[key];
    if (Array.isArray(value)) {
      return value.flatMap((item) => item.split(/[\s,]+/)).filter(Boolean);
    }
    if (typeof value === "string" || typeof value === "number") {
      return String(value)
        .split(/[\s,]+/)
        .filter(Boolean);
    }
  }
  return [];
}

function selectedGpuDeviceRefs(
  instance: Instance,
  options: PreflightOptions,
): string[] {
  const tensorParallel = instanceArgNumber(
    instance,
    SGLANG_TENSOR_PARALLEL_KEYS,
    1,
  );
  if (!Number.isInteger(tensorParallel) || tensorParallel < 1) return [];
  const visible = parseCudaVisibleDevices(instance.env.CUDA_VISIBLE_DEVICES);
  const candidates =
    visible.mode === "list"
      ? visible.ids
      : nvidiaGpuAccelerators(options).map((accelerator) => accelerator.id);
  return candidates.slice(0, tensorParallel);
}

function validateMemoryReservations(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const pools: MemoryPool[] = options.memoryPools ?? listMemoryPools();
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const positiveDraws = instance.memory.filter((draw) => draw.bytes > 0);
  const hasHost = positiveDraws.some(
    (draw) => poolById.get(draw.poolId)?.kind === "host",
  );
  if (!hasHost) {
    issue(
      issues,
      "error",
      "memory",
      "KTransformers requires a positive host-memory reservation for CPU weights and workers",
    );
  }

  const selectedRefs = selectedGpuDeviceRefs(instance, options);
  const selectedPoolIds = new Set<string>();
  for (const deviceRef of selectedRefs) {
    const pool = pools.find(
      (candidate) =>
        candidate.kind === "gpu" && candidate.deviceRef === deviceRef,
    );
    if (!pool) {
      issue(
        issues,
        "error",
        "memory",
        `No memory pool maps to selected CUDA device ${deviceRef}`,
      );
      continue;
    }
    selectedPoolIds.add(pool.id);
    if (
      !positiveDraws.some((draw) => draw.poolId === pool.id && draw.bytes > 0)
    ) {
      issue(
        issues,
        "error",
        "memory",
        `KTransformers requires a positive reservation on selected GPU pool ${pool.name}`,
      );
    }
  }

  for (const draw of positiveDraws) {
    const pool = poolById.get(draw.poolId);
    if (pool?.kind === "gpu" && !selectedPoolIds.has(pool.id)) {
      issue(
        issues,
        "error",
        "memory",
        `GPU reservation ${pool.name} is outside CUDA visibility and tensor-parallel order`,
      );
    }
  }
}

function validateNuma(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const topology: NumaNode[] = options.numaNodes ?? readNumaTopology();
  const managerNumaApplies = numaIsApplicable(topology);
  if (managerNumaApplies && instance.numa?.mode === "interleave") {
    issue(
      issues,
      "error",
      "numa.mode",
      "KTransformers manages its own NUMA placement; manager interleave mode is not allowed",
    );
  }

  const rawCount = instanceArgNumber(instance, ["--kt-threadpool-count"], 1);
  if (!Number.isInteger(rawCount) || rawCount < 1) {
    issue(
      issues,
      "error",
      "args.--kt-threadpool-count",
      "KTransformers thread-pool count must be a positive integer",
    );
    return;
  }
  const nodes = argValues(instance, ["--kt-numa-nodes"]);
  if (rawCount > 1 && nodes.length === 0) {
    issue(
      issues,
      "error",
      "args.--kt-numa-nodes",
      "Explicit NUMA nodes are required when KTransformers uses multiple thread pools",
    );
    return;
  }
  if (nodes.length > 0 && nodes.length !== rawCount) {
    issue(
      issues,
      "error",
      "args.--kt-numa-nodes",
      `Expected ${rawCount} NUMA node value(s), received ${nodes.length}`,
    );
  }
  const parsed = nodes.map((node) => Number(node));
  if (parsed.some((node) => !Number.isInteger(node) || node < 0)) {
    issue(
      issues,
      "error",
      "args.--kt-numa-nodes",
      "KTransformers NUMA nodes must be non-negative integers",
    );
    return;
  }
  if (new Set(parsed).size !== parsed.length) {
    issue(
      issues,
      "error",
      "args.--kt-numa-nodes",
      "Each KTransformers thread pool must use a distinct NUMA node",
    );
  }
  const online = topology.filter((node) => node.online);
  const known = new Set(online.map((node) => node.id));
  for (const node of parsed) {
    if (!known.has(node)) {
      issue(
        issues,
        "error",
        "args.--kt-numa-nodes",
        `NUMA node ${node} is not online on this host`,
      );
    } else if ((online.find((entry) => entry.id === node)?.cpuCount ?? 0) < 1) {
      issue(
        issues,
        "error",
        "args.--kt-numa-nodes",
        `NUMA node ${node} has no online CPU cores for a KTransformers thread pool`,
      );
    }
  }
  const managerBindNode =
    managerNumaApplies && instance.numa?.mode === "bind"
      ? instance.numa.node
      : null;
  if (
    managerBindNode !== null &&
    parsed.some((node) => node !== managerBindNode)
  ) {
    issue(
      issues,
      "error",
      "numa.node",
      "Manager NUMA binding must match every KTransformers internal NUMA node",
    );
  }
}

function detectedCpuFlags() {
  if (process.platform !== "linux") return new Set<string>();
  try {
    const match = /^flags\s*:\s*(.+)$/im.exec(
      readFileSync("/proc/cpuinfo", "utf8"),
    );
    return new Set(
      (match?.[1] ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}

function detectedPhysicalCoreCount() {
  const available = availableParallelism();
  if (process.platform !== "linux") return available;
  try {
    const blocks = readFileSync("/proc/cpuinfo", "utf8")
      .split(/\n\s*\n/)
      .filter(Boolean);
    const processors = new Set<string>();
    const physicalCores = new Set<string>();
    for (const block of blocks) {
      const processor = /^processor\s*:\s*(\d+)$/im.exec(block)?.[1];
      if (processor) {
        processors.add(processor);
      }
      const physicalId = /^physical id\s*:\s*(\d+)$/im.exec(block)?.[1];
      const coreId = /^core id\s*:\s*(\d+)$/im.exec(block)?.[1];
      if (physicalId !== undefined && coreId !== undefined) {
        physicalCores.add(`${physicalId}:${coreId}`);
      }
    }
    const detected =
      physicalCores.size > 0 ? physicalCores.size : processors.size;
    return detected > 0 ? Math.min(detected, available) : available;
  } catch {
    return available;
  }
}

function detectedSwapTotalBytes() {
  if (process.platform !== "linux") return 0;
  try {
    const match = /^SwapTotal:\s+(\d+)\s+kB$/im.exec(
      readFileSync("/proc/meminfo", "utf8"),
    );
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

const METHOD_CPU_FEATURES: Record<KTransformersMethod, string[]> = {
  AMXINT4: ["amx_int8"],
  AMXINT8: ["amx_int8"],
  RAWINT4: ["avx2"],
  FP8: ["avx2"],
  FP8_PERCHANNEL: ["avx512f"],
  BF16: ["avx2"],
  LLAMAFILE: ["avx2"],
};

const LEGACY_METHOD_CPU_FEATURES: Array<{
  method: KTransformersMethod;
  below: [number, number, number];
  required: string[];
}> = [
  { method: "RAWINT4", below: [0, 6, 2], required: ["avx512f"] },
  { method: "FP8", below: [0, 7, 0], required: ["avx512f"] },
  { method: "BF16", below: [0, 7, 0], required: ["avx512f", "avx512_bf16"] },
];

function versionAtLeast(version: string, minimum: [number, number, number]) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

function validateCpuMethod(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
  runtime: KTransformersRuntime | null,
) {
  if (instance.engineConfig?.type !== "ktransformers") return;
  const method = instance.engineConfig.method;
  const flags = options.cpuFlags
    ? new Set(options.cpuFlags.map((flag) => flag.toLowerCase()))
    : detectedCpuFlags();
  const legacy = runtime
    ? LEGACY_METHOD_CPU_FEATURES.find(
        (entry) =>
          entry.method === method &&
          !versionAtLeast(runtime.ktKernelVersion, entry.below),
      )
    : undefined;
  const required = legacy ? legacy.required : METHOD_CPU_FEATURES[method];
  const missing = required.filter((feature) => !flags.has(feature));
  if (missing.length > 0) {
    issue(
      issues,
      "error",
      "engineConfig.method",
      `${method} requires CPU instruction set ${missing.join(", ")} in the supported package profile`,
    );
  }
}

function validateCpuSizing(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const value = instance.args["--kt-cpuinfer"];
  if (value === undefined || value === null || value === false) return;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    issue(
      issues,
      "error",
      "args.--kt-cpuinfer",
      "KTransformers CPU inference threads must be a positive integer",
    );
    return;
  }
  const physicalCores =
    options.physicalCoreCount ?? detectedPhysicalCoreCount();
  if (physicalCores > 0 && count > physicalCores) {
    issue(
      issues,
      "error",
      "args.--kt-cpuinfer",
      `KTransformers CPU inference threads ${count} exceed ${physicalCores} physical core(s) available to the manager`,
    );
  } else if (
    physicalCores > 0 &&
    Math.abs(count - physicalCores) / physicalCores >= 0.25
  ) {
    issue(
      issues,
      "warning",
      "args.--kt-cpuinfer",
      `KTransformers CPU inference threads ${count} differ substantially from ${physicalCores} detected physical core(s)`,
    );
  }
}

function validateGpuExpertPlacement(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  const count = configuredInstanceArg(instance, [
    "--kt-num-gpu-experts",
    "--kt-gpu-experts",
  ]);
  const ratio = configuredInstanceArg(instance, ["--kt-gpu-experts-ratio"]);
  if (!count && !ratio) {
    issue(
      issues,
      "error",
      "args.--kt-num-gpu-experts",
      "KTransformers requires --kt-num-gpu-experts or --kt-gpu-experts-ratio",
    );
    return;
  }
  if (count) {
    const parsed = Number(count.value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      issue(
        issues,
        "error",
        `args.${count.key}`,
        `${count.key} must be a non-negative integer`,
      );
    }
  }
  if (ratio) {
    const parsed = Number(ratio.value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      issue(
        issues,
        "error",
        `args.${ratio.key}`,
        `${ratio.key} must be between 0 and 1`,
      );
    }
  }
  if (count && ratio) {
    issue(
      issues,
      "warning",
      `args.${ratio.key}`,
      `${count.key} and ${ratio.key} are both set; verify the selected SGLang-KT version's precedence rule`,
    );
  }
}

function validateOperationalWarnings(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  if (instance.engineConfig?.type !== "ktransformers") return;
  const { model, cpuWeights } = instance.engineConfig;
  if (!existsSync(model)) {
    issue(
      issues,
      "warning",
      "engineConfig.model",
      "Remote KTransformers model resolution can download data and makes cold-start time unbounded",
    );
  } else if (
    instance.engineConfig.method === "LLAMAFILE" &&
    resolve(model) === resolve(cpuWeights)
  ) {
    issue(
      issues,
      "warning",
      "engineConfig.cpuWeights",
      "LLAMAFILE expects GGUF CPU weights, but model and CPU weights resolve to the same directory",
    );
  }
  const swapTotal = options.swapTotalBytes ?? detectedSwapTotalBytes();
  if (swapTotal > 0) {
    issue(
      issues,
      "warning",
      "memory",
      `Host swap is enabled (${formatGib(swapTotal)}); swapping CPU expert weights can severely degrade KTransformers`,
    );
  }
  const availableHost =
    options.hostAvailableMemoryBytes ??
    getSystemResources().memory.availableBytes;
  const hostPoolIds = new Set(
    (options.memoryPools ?? listMemoryPools())
      .filter((pool) => pool.kind === "host")
      .map((pool) => pool.id),
  );
  const declaredHostBytes = instance.memory
    .filter((draw) => hostPoolIds.has(draw.poolId))
    .reduce((total, draw) => total + Math.max(0, draw.bytes), 0);
  if (declaredHostBytes > availableHost) {
    issue(
      issues,
      "warning",
      "memory",
      `Declared host-memory draw exceeds currently available RAM by ${formatGib(declaredHostBytes - availableHost)}`,
    );
  }
}

export async function validateKTransformersPreflight(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    issue(
      issues,
      "error",
      "binaryPathRefId",
      "KTransformers is supported only on Linux x86-64",
    );
  }
  if (instance.engineConfig?.type !== "ktransformers") {
    issue(
      issues,
      "error",
      "engineConfig",
      "KTransformers typed engine configuration is missing",
    );
    return;
  }

  validateModel(instance.engineConfig.model, issues);
  validateCpuWeights(instance.engineConfig.cpuWeights, issues);
  const runtime = await validateRuntime(instance, issues, options);
  await validateSglangArgumentCompatibility(instance, issues);
  validateSglangCuda(instance, issues, options, {
    engineLabel: "KTransformers",
    minimum: ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.ktransformers,
  });
  validateMemoryReservations(instance, issues, options);
  validateNuma(instance, issues, options);
  validateCpuMethod(instance, issues, options, runtime);
  validateCpuSizing(instance, issues, options);
  validateGpuExpertPlacement(instance, issues);
  validateOperationalWarnings(instance, issues, options);
  validateSglangServingWarnings(instance, issues, "SGLang-KT");
  validateSglangManagedBoundary(instance, issues, "KTransformers");
}
