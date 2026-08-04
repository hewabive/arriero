import { ENVIRONMENT_UV_MIN_VERSION, type UvToolStatus } from "@arriero/core";
import { execFileSync } from "node:child_process";

import { findExecutableInPath } from "../system/tool-probe.js";

export type UvProbe =
  | { path: string; version: string; error: null }
  | { path: string | null; version: string | null; error: string };

export function isSupportedUvVersionOutput(output: string): boolean {
  const match = /^uv (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  const minimum = ENVIRONMENT_UV_MIN_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function readUvVersion(path: string): string | null {
  try {
    return (
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function probeUv(pathValue = process.env.PATH): UvProbe {
  const path = findExecutableInPath("uv", pathValue);
  if (!path) {
    return {
      path: null,
      version: null,
      error: `uv >=${ENVIRONMENT_UV_MIN_VERSION} was not found on PATH`,
    };
  }
  const version = readUvVersion(path);
  if (!version) {
    return {
      path,
      version: null,
      error: `could not read uv version from ${path}`,
    };
  }
  if (!isSupportedUvVersionOutput(version)) {
    return {
      path,
      version,
      error: `uv >=${ENVIRONMENT_UV_MIN_VERSION} is required, found ${version} at ${path}`,
    };
  }
  return { path, version, error: null };
}

let cached: UvToolStatus | null = null;

export function uvToolStatus(): UvToolStatus {
  if (cached) return cached;
  const probe = probeUv();
  cached = {
    available: probe.error === null,
    path: probe.path,
    version: probe.version,
    reason: probe.error,
  };
  return cached;
}

export function resetUvToolStatusCache() {
  cached = null;
}
