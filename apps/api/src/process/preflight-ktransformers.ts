import type {
  Instance,
  MemoryPool,
  NumaNode,
  ProcessPreflightIssue,
  SystemAccelerator,
} from "@llama-manager/core";
import { parseCudaVisibleDevices } from "@llama-manager/core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { getSystemResources } from "../system/resources.js";
import { getArgumentCatalog } from "../arguments/catalog.js";
import { readNumaTopology } from "../numa/topology.js";
import { listMemoryPools } from "../resources/repository.js";
import type { PreflightOptions } from "./preflight.js";

const HF_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function issue(
  issues: ProcessPreflightIssue[],
  level: ProcessPreflightIssue["level"],
  field: string,
  message: string,
) {
  issues.push({ level, field, message });
}

function localAccelerators(options: PreflightOptions): SystemAccelerator[] {
  return options.accelerators ?? getSystemResources().accelerators;
}

function nvidiaAccelerators(options: PreflightOptions) {
  return localAccelerators(options).filter(
    (accelerator) =>
      accelerator.kind === "gpu" &&
      (accelerator.vendor === "NVIDIA" || accelerator.source === "nvidia-smi"),
  );
}

function validateModel(model: string, issues: ProcessPreflightIssue[]) {
  if (existsSync(model)) {
    return;
  }
  if (isAbsolute(model) || model.startsWith("./") || model.startsWith("../")) {
    issue(
      issues,
      "error",
      "engineConfig.model",
      `KTransformers model path does not exist: ${model}`,
    );
    return;
  }
  if (!HF_MODEL_ID.test(model)) {
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
    if (!stat.isDirectory() && !stat.isFile()) {
      issue(
        issues,
        "error",
        "engineConfig.cpuWeights",
        `KTransformers CPU weights are not a file or directory: ${path}`,
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

function validateRuntime(instance: Instance, issues: ProcessPreflightIssue[]) {
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
    return;
  }
  const result = spawnSync(
    python,
    [
      "-c",
      [
        "import sys",
        "import kt_kernel",
        "import sglang",
        "print(f'{sys.version_info.major}.{sys.version_info.minor}')",
      ].join("; "),
    ],
    { encoding: "utf8", timeout: 3_000 },
  );
  if (result.error || result.status !== 0) {
    issue(
      issues,
      "error",
      "binaryPathRefId",
      "KTransformers runtime imports failed in the selected environment",
    );
    return;
  }
  const version = result.stdout.trim().split(/\s+/).at(-1) ?? "";
  if (version !== "3.11" && version !== "3.12") {
    issue(
      issues,
      "error",
      "binaryPathRefId",
      `KTransformers requires Python 3.11 or 3.12; selected environment reports ${version || "unknown"}`,
    );
  }
}

function argNumber(instance: Instance, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = instance.args[key];
    if (value === undefined || value === null || value === false) continue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return fallback;
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

function validateCuda(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const detected = nvidiaAccelerators(options);
  if (detected.length === 0) {
    issue(
      issues,
      "error",
      "env.CUDA_VISIBLE_DEVICES",
      "KTransformers requires an NVIDIA GPU visible to nvidia-smi",
    );
    return;
  }
  const visible = parseCudaVisibleDevices(instance.env.CUDA_VISIBLE_DEVICES);
  if (visible.mode === "none") {
    issue(
      issues,
      "error",
      "env.CUDA_VISIBLE_DEVICES",
      "KTransformers cannot start with CUDA devices disabled",
    );
    return;
  }
  const visibleCount =
    visible.mode === "list" ? visible.ids.length : detected.length;
  const tensorParallel = argNumber(
    instance,
    ["--tensor-parallel-size", "--tp"],
    1,
  );
  if (!Number.isInteger(tensorParallel) || tensorParallel < 1) {
    issue(
      issues,
      "error",
      "args.--tensor-parallel-size",
      "Tensor parallel size must be a positive integer",
    );
  } else if (tensorParallel > visibleCount) {
    issue(
      issues,
      "error",
      "args.--tensor-parallel-size",
      `Tensor parallel size ${tensorParallel} exceeds ${visibleCount} visible NVIDIA GPU(s)`,
    );
  }
}

function selectedGpuDeviceRefs(
  instance: Instance,
  options: PreflightOptions,
): string[] {
  const tensorParallel = argNumber(
    instance,
    ["--tensor-parallel-size", "--tp"],
    1,
  );
  if (!Number.isInteger(tensorParallel) || tensorParallel < 1) return [];
  const visible = parseCudaVisibleDevices(instance.env.CUDA_VISIBLE_DEVICES);
  const candidates =
    visible.mode === "list"
      ? visible.ids
      : nvidiaAccelerators(options).map((accelerator) => accelerator.id);
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
  if (instance.numa?.mode === "interleave") {
    issue(
      issues,
      "error",
      "numa.mode",
      "KTransformers manages its own NUMA placement; manager interleave mode is not allowed",
    );
  }

  const rawCount = argNumber(instance, ["--kt-threadpool-count"], 1);
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
  const topology: NumaNode[] = options.numaNodes ?? readNumaTopology();
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
    instance.numa?.mode === "bind" ? instance.numa.node : null;
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

function cpuFlags() {
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

function validateCpuMethod(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  if (instance.engineConfig?.type !== "ktransformers") return;
  const method = instance.engineConfig.method;
  const flags = cpuFlags();
  if (["AMXINT4", "AMXINT8"].includes(method) && !flags.has("amx_int8")) {
    issue(
      issues,
      "error",
      "engineConfig.method",
      `${method} requires the CPU amx_int8 instruction set`,
    );
  }
  if (["RAWINT4", "LLAMAFILE"].includes(method) && !flags.has("avx2")) {
    issue(
      issues,
      "error",
      "engineConfig.method",
      `${method} requires the CPU avx2 instruction set`,
    );
  }
  if (method === "BF16" && !flags.has("avx512_bf16")) {
    issue(
      issues,
      "warning",
      "engineConfig.method",
      "BF16 was selected but avx512_bf16 was not detected; verify upstream CPU support",
    );
  }
}

function validateManagedBoundary(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  if (Object.hasOwn(instance.args, "--api-key")) {
    issue(
      issues,
      "error",
      "args.--api-key",
      "Managed KTransformers authentication terminates at llama-manager; --api-key is not allowed",
    );
  }
  const host = String(instance.args["--host"] ?? "127.0.0.1").trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    issue(
      issues,
      "error",
      "args.--host",
      "Managed KTransformers must bind to loopback",
    );
  }
  if ((instance.positionalArgs?.length ?? 0) > 0) {
    issue(
      issues,
      "error",
      "positionalArgs",
      "Managed KTransformers does not accept positional model arguments",
    );
  }
}

function validateArgumentCompatibility(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  let catalog: ReturnType<typeof getArgumentCatalog>;
  try {
    catalog = getArgumentCatalog(instance.binaryPath, {
      parserId: "sglang-help",
    });
  } catch (error) {
    issue(
      issues,
      "warning",
      "args",
      `Unable to inspect SGLang argument compatibility: ${(error as Error).message}`,
    );
    return;
  }
  const byName = new Map(
    catalog.options.flatMap((option) =>
      [option.primaryName, ...option.names].map(
        (name) => [name, option] as const,
      ),
    ),
  );
  for (const [key, value] of Object.entries(instance.args)) {
    if (value === false || value === null) continue;
    const option = byName.get(key);
    if (!option) {
      issue(
        issues,
        "warning",
        `args.${key}`,
        "Argument was not found in selected SGLang help; the runtime may reject it",
      );
      continue;
    }
    const empty =
      value === "" ||
      (Array.isArray(value) && value.every((item) => !item.trim()));
    if (option.valueType !== "flag" && empty) {
      issue(
        issues,
        "error",
        `args.${key}`,
        `Argument ${option.primaryName} requires a value`,
      );
    }
  }
}

export function validateKTransformersPreflight(
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
  validateRuntime(instance, issues);
  validateArgumentCompatibility(instance, issues);
  validateCuda(instance, issues, options);
  validateMemoryReservations(instance, issues, options);
  validateNuma(instance, issues, options);
  validateCpuMethod(instance, issues);
  validateManagedBoundary(instance, issues);
}
