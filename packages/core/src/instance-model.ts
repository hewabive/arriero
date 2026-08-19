import type { Instance } from "./instance.js";

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
  return value.replace(/\.gguf$/i, "");
}

export const SGLANG_MODEL_ARG_KEYS = ["--model-path", "--model"] as const;

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
