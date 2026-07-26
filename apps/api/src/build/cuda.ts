import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  executableName,
  findExecutableInPath,
  resolveExecutable,
} from "../system/tool-probe.js";

function envPath(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function findNvcc(env: NodeJS.ProcessEnv) {
  const explicit = envPath(env, "CUDACXX");
  if (explicit) {
    return resolveExecutable(explicit, env) ?? explicit;
  }

  const fromPath = findExecutableInPath("nvcc", env.PATH);
  if (fromPath) {
    return fromPath;
  }

  const cudaRoots = [
    envPath(env, "CUDA_HOME"),
    envPath(env, "CUDA_PATH"),
    "/usr/local/cuda",
    "/opt/cuda",
  ].filter((item): item is string => Boolean(item));

  for (const root of cudaRoots) {
    const candidate = join(root, "bin", executableName("nvcc"));
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isCudaToolkitAvailable() {
  return findNvcc(process.env) !== null;
}
