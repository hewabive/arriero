import {
  ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY,
  parseCudaVisibleDevices,
  type Instance,
  type ProcessPreflightIssue,
} from "@arriero/core";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { environmentSpecForBinaryPath } from "../envs/repository.js";
import {
  nvidiaGpuAccelerators,
  pushCudaComputeCapabilityIssues,
} from "./preflight-cuda.js";
import type { PreflightOptions } from "./preflight.js";

function localModelPath(instance: Instance, model: string) {
  if (isAbsolute(model)) {
    return model;
  }
  if (
    model === "." ||
    model === ".." ||
    model.startsWith("./") ||
    model.startsWith("../")
  ) {
    return resolve(instance.cwd ?? dirname(instance.binaryPath), model);
  }
  return null;
}

function validateModel(instance: Instance, issues: ProcessPreflightIssue[]) {
  const models = (instance.positionalArgs ?? []).filter(
    (value) => value.trim().length > 0,
  );
  if (models.length === 0) {
    issues.push({
      level: "error",
      field: "positionalArgs",
      message: "vLLM requires a model name or local model path.",
    });
    return;
  }

  const model = models[0]!;
  const path = localModelPath(instance, model);
  if (!path) {
    return;
  }
  if (!existsSync(path)) {
    issues.push({
      level: "error",
      field: "positionalArgs.0",
      message: `Local vLLM model path not found: ${path}`,
    });
    return;
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    issues.push({
      level: "error",
      field: "positionalArgs.0",
      message: `Local vLLM model path is not readable: ${path}`,
    });
  }
}

function vllmEnvironmentVariant(instance: Instance) {
  const spec = environmentSpecForBinaryPath(instance.binaryPath);
  return spec?.engine === "vllm" ? spec.variant : null;
}

function validateGpu(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const variant = vllmEnvironmentVariant(instance);
  if (variant === "cpu" || variant === "rocm") {
    return;
  }
  const detected = nvidiaGpuAccelerators(options);
  if (detected.length === 0) {
    if (variant === "cuda") {
      issues.push({
        level: "error",
        field: "gpu",
        message:
          "This vLLM CUDA environment requires an NVIDIA GPU available through NVML",
      });
    }
    return;
  }
  const visible = parseCudaVisibleDevices(instance.env.CUDA_VISIBLE_DEVICES);
  if (visible.mode === "none") {
    if (variant === "cuda") {
      issues.push({
        level: "error",
        field: "env.CUDA_VISIBLE_DEVICES",
        message:
          "This vLLM CUDA environment cannot start with CUDA devices disabled",
      });
    }
    return;
  }
  pushCudaComputeCapabilityIssues({
    issues,
    detected,
    visible,
    minimum: ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.vllm,
    engineLabel: "vLLM",
    level: variant === "cuda" ? "error" : "warning",
  });
}

export function validateVllmPreflight(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  validateModel(instance, issues);
  validateGpu(instance, issues, options);
}
