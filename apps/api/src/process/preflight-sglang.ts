import type {
  ComputeCapability,
  Instance,
  ProcessPreflightIssue,
} from "@arriero/core";
import {
  ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY,
  engineDescriptor,
  isHfRepoId,
  parseCudaVisibleDevices,
  sglangModelArg,
  SGLANG_TENSOR_PARALLEL_KEYS,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { getArgumentCatalogAsync } from "../arguments/catalog.js";
import {
  nvidiaGpuAccelerators,
  pushCudaComputeCapabilityIssues,
} from "./preflight-cuda.js";
import {
  configuredInstanceArg,
  instanceArgNumber,
  isExplicitPath,
  issue,
} from "./preflight-shared.js";
import type { PreflightOptions } from "./preflight.js";

export function validateSglangCuda(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
  config: { engineLabel: string; minimum: ComputeCapability },
) {
  const detected = nvidiaGpuAccelerators(options);
  if (detected.length === 0) {
    issue(
      issues,
      "error",
      "env.CUDA_VISIBLE_DEVICES",
      `${config.engineLabel} requires an NVIDIA GPU available through NVML`,
    );
    return;
  }
  const visible = parseCudaVisibleDevices(instance.env.CUDA_VISIBLE_DEVICES);
  if (visible.mode === "none") {
    issue(
      issues,
      "error",
      "env.CUDA_VISIBLE_DEVICES",
      `${config.engineLabel} cannot start with CUDA devices disabled`,
    );
    return;
  }
  const visibleCount =
    visible.mode === "list" ? visible.ids.length : detected.length;
  const tensorParallel = instanceArgNumber(
    instance,
    SGLANG_TENSOR_PARALLEL_KEYS,
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
  pushCudaComputeCapabilityIssues({
    issues,
    detected,
    visible,
    minimum: config.minimum,
    engineLabel: config.engineLabel,
    level: "error",
  });
}

export function validateSglangServingWarnings(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  engineLabel: string,
) {
  if (!configuredInstanceArg(instance, ["--mem-fraction-static"])) {
    issue(
      issues,
      "warning",
      "args.--mem-fraction-static",
      `${engineLabel} will choose GPU static-memory allocation because --mem-fraction-static is not set`,
    );
  }
  if (
    configuredInstanceArg(instance, [
      "--tokenizer-metrics-allowed-custom-labels",
    ])
  ) {
    issue(
      issues,
      "warning",
      "args.--tokenizer-metrics-allowed-custom-labels",
      "The arriero proxy strips the client metrics-labels header, so custom tokenizer metric labels only apply to clients that reach the instance port directly",
    );
  }
}

export function validateSglangManagedBoundary(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  engineLabel: string,
) {
  if (Object.hasOwn(instance.args, "--api-key")) {
    issue(
      issues,
      "error",
      "args.--api-key",
      `Managed ${engineLabel} authentication terminates at arriero; --api-key is not allowed`,
    );
  }
  const host = String(instance.args["--host"] ?? "127.0.0.1").trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    issue(
      issues,
      "error",
      "args.--host",
      `Managed ${engineLabel} must bind to loopback`,
    );
  }
  if ((instance.positionalArgs?.length ?? 0) > 0) {
    issue(
      issues,
      "error",
      "positionalArgs",
      `Managed ${engineLabel} does not accept positional model arguments`,
    );
  }
}

export async function validateSglangArgumentCompatibility(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  const parserId = engineDescriptor(instance.kind).preflight
    .argumentCatalogParser;
  if (parserId === "none") {
    return;
  }
  let catalog: Awaited<ReturnType<typeof getArgumentCatalogAsync>>;
  try {
    catalog = await getArgumentCatalogAsync(instance.binaryPath, { parserId });
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

function validateModel(instance: Instance, issues: ProcessPreflightIssue[]) {
  const model = sglangModelArg(instance);
  if (!model) {
    issue(
      issues,
      "error",
      "args.--model-path",
      "SGLang requires --model-path with a local model path or owner/model Hugging Face id",
    );
    return;
  }
  if (existsSync(model)) {
    return;
  }
  if (isExplicitPath(model)) {
    issue(
      issues,
      "error",
      "args.--model-path",
      `SGLang model path does not exist: ${model}`,
    );
    return;
  }
  if (!isHfRepoId(model)) {
    issue(
      issues,
      "error",
      "args.--model-path",
      "SGLang model must be an existing local path or owner/model Hugging Face id",
    );
    return;
  }
  issue(
    issues,
    "warning",
    "args.--model-path",
    "Remote SGLang model resolution can download data and makes cold-start time unbounded",
  );
}

export async function validateSglangPreflight(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  validateModel(instance, issues);
  await validateSglangArgumentCompatibility(instance, issues);
  validateSglangCuda(instance, issues, options, {
    engineLabel: "SGLang",
    minimum: ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.sglang,
  });
  validateSglangServingWarnings(instance, issues, "SGLang");
  validateSglangManagedBoundary(instance, issues, "SGLang");
}
