import type { EnvironmentSpec } from "@llama-manager/core";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  environmentDirectory,
  environmentEntrypoint,
  environmentStagingDirectory,
} from "./paths.js";

function executableError(path: string, description: string) {
  if (!existsSync(path)) return `${description} is missing: ${path}`;
  try {
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `${description} is not executable: ${path}`;
  }
}

export function environmentLayoutError(spec: EnvironmentSpec): string | null {
  const directory = environmentDirectory(spec);
  if (!existsSync(directory)) return `environment directory is missing: ${directory}`;

  const entrypoint = environmentEntrypoint(spec);
  const entrypointError = executableError(entrypoint, "vLLM entrypoint");
  if (entrypointError) return entrypointError;

  const python = resolve(directory, "bin", "python");
  const pythonError = executableError(python, "environment Python");
  if (pythonError) return pythonError;

  const freeze = resolve(directory, "freeze.txt");
  if (!existsSync(freeze)) return `environment freeze file is missing: ${freeze}`;
  const frozen = readFileSync(freeze, "utf8");
  if (!frozen.split(/\r?\n/).includes(`vllm==${spec.version}`)) {
    return `environment freeze does not contain vllm==${spec.version}`;
  }

  const launcher = readFileSync(entrypoint, "utf8").slice(0, 4096);
  const staging = environmentStagingDirectory(spec);
  if (launcher.includes(staging)) {
    return `vLLM entrypoint still references staging directory: ${staging}`;
  }
  return null;
}
