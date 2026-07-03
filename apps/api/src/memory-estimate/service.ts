import {
  engineDescriptor,
  estimateInstanceMemory,
  type InstanceArgs,
  type MemoryEstimate,
  type MemoryEstimateArgs,
  type MemoryEstimateHparams,
  type MemoryEstimatePoolInput,
  type MemoryEstimateRequest,
} from "@llama-manager/core";
import { existsSync } from "node:fs";

import { getInstance } from "../instances/repository.js";
import { readGgufMetadata, readGgufModelTensorTable } from "../models/gguf.js";
import { listMemoryPools } from "../resources/repository.js";

export type MemoryEstimateResolution =
  | { ok: true; modelPath: string; estimate: MemoryEstimate }
  | { ok: false; reason: string };

function poolsForEstimate(): MemoryEstimatePoolInput[] {
  return listMemoryPools().map((pool) => {
    const deviceIndex =
      pool.deviceRef !== null && Number.isFinite(Number(pool.deviceRef))
        ? Number(pool.deviceRef)
        : null;
    return { id: pool.id, kind: pool.kind, deviceIndex };
  });
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
    contextLength: metadata.contextLength,
    slidingWindow: metadata.slidingWindow,
    sharedKvLayers: metadata.sharedKvLayers,
    ssmConvKernel: metadata.ssmConvKernel,
    ssmGroupCount: metadata.ssmGroupCount,
    ssmInnerSize: metadata.ssmInnerSize,
    ssmStateSize: metadata.ssmStateSize,
    vocabularySize: metadata.vocabularySize,
  };
}

export function estimateMemory(
  request: MemoryEstimateRequest,
): MemoryEstimateResolution {
  let args: MemoryEstimateArgs = {};
  if (request.instanceId) {
    const instance = getInstance(request.instanceId);
    if (!instance) {
      return { ok: false, reason: `instance not found: ${request.instanceId}` };
    }
    if (engineDescriptor(instance.kind).estimator !== "gguf") {
      return {
        ok: false,
        reason: `memory estimate is not applicable to ${instance.kind} instances`,
      };
    }
    args = { ...(instance.args as InstanceArgs) };
  }
  if (request.args) {
    args = { ...args, ...request.args };
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
      pools: poolsForEstimate(),
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
