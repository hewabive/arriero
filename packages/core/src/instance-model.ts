import type { Instance } from "./instance.js";
import { parseSplitInfo } from "./gguf-split.js";

export type InstanceModelSource = Pick<
  Instance,
  "kind" | "args" | "positionalArgs" | "engineConfig"
>;

function pathTail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function stringArg(source: InstanceModelSource, key: string): string | null {
  const value = source.args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringArg(
  source: InstanceModelSource,
  key: string,
): string | null {
  const value = source.args[key];
  if (Array.isArray(value)) {
    return value.find((item) => item.trim())?.trim() ?? null;
  }
  return stringArg(source, key);
}

export function stripGgufSuffix(value: string): string {
  return parseSplitInfo(value)?.prefix ?? value.replace(/\.gguf$/i, "");
}

export const SGLANG_MODEL_ARG_KEYS = ["--model-path", "--model"] as const;

export const MMPROJ_ARG_KEYS: readonly string[] = ["--mmproj", "-mm"];

export const DRAFT_MODEL_ARG_KEYS: readonly string[] = [
  "--spec-draft-model",
  "-md",
  "--model-draft",
];

function firstKeyString(
  source: InstanceModelSource,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = stringArg(source, key);
    if (value) {
      return value;
    }
  }
  return null;
}

export function instanceModelPaths(source: InstanceModelSource): string[] {
  const values: Array<string | null | undefined> = [];
  if (source.kind === "llama-server") {
    values.push(firstKeyString(source, ["--model", "-m"]));
    for (const key of [...MMPROJ_ARG_KEYS, ...DRAFT_MODEL_ARG_KEYS]) {
      values.push(stringArg(source, key));
    }
  } else if (source.kind === "vllm") {
    values.push(source.positionalArgs?.find((item) => item.trim())?.trim());
  } else if (source.kind === "sglang") {
    values.push(sglangModelArg(source));
  }
  if (source.engineConfig?.type === "ktransformers") {
    values.push(source.engineConfig.model, source.engineConfig.cpuWeights);
  }
  return values.filter(
    (value): value is string =>
      typeof value === "string" && value.startsWith("/"),
  );
}

export function sglangModelArg(source: InstanceModelSource): string | null {
  for (const key of SGLANG_MODEL_ARG_KEYS) {
    const value = stringArg(source, key);
    if (value) {
      return value;
    }
  }
  return null;
}

export function isRouterInstance(source: InstanceModelSource): boolean {
  return (
    Boolean(stringArg(source, "--models-preset")) &&
    !stringArg(source, "--model")
  );
}

export function impliedInstanceModelId(
  source: InstanceModelSource,
): string | null {
  if (source.engineConfig?.type === "ktransformers") {
    const model = source.engineConfig.model;
    const localPath =
      model.startsWith("/") ||
      model.startsWith("./") ||
      model.startsWith("../");
    return (
      source.engineConfig.servedModelName ??
      (localPath ? pathTail(model) : model)
    );
  }
  if (source.kind === "vllm") {
    return (
      firstStringArg(source, "--served-model-name") ??
      source.positionalArgs?.find((item) => item.trim())?.trim() ??
      null
    );
  }
  if (source.kind === "sglang") {
    const served = firstStringArg(source, "--served-model-name");
    if (served) {
      return served;
    }
    const model = sglangModelArg(source);
    return model ? pathTail(model) : null;
  }
  if (isRouterInstance(source)) {
    return null;
  }
  const alias = stringArg(source, "--alias");
  if (alias) {
    return alias;
  }
  const model = stringArg(source, "--model");
  return model ? pathTail(model) : null;
}
