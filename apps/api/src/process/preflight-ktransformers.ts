import type {
  Instance,
  ProcessPreflightIssue,
  SystemAccelerator,
} from "@llama-manager/core";
import { parseCudaVisibleDevices } from "@llama-manager/core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { getSystemResources } from "../system/resources.js";
import { getArgumentCatalog } from "../arguments/catalog.js";
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
  validateCpuMethod(instance, issues);
  validateManagedBoundary(instance, issues);
}
