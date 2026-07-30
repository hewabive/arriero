import type { Instance, ProcessPreflightIssue } from "@arriero/core";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

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

export function validateVllmPreflight(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  _options: PreflightOptions,
) {
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
