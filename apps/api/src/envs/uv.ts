import { ENVIRONMENT_UV_MIN_VERSION, type UvToolStatus } from "@arriero/core";
import { execFileSync } from "node:child_process";

import { findExecutableInPath } from "../system/tool-probe.js";

function findUv(pathValue = process.env.PATH): string | null {
  return findExecutableInPath("uv", pathValue);
}

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

export function findSupportedUv(pathValue = process.env.PATH): string | null {
  const path = findUv(pathValue);
  if (!path) return null;
  const version = readUvVersion(path);
  return version && isSupportedUvVersionOutput(version) ? path : null;
}

export function uvCompatibilityError(
  pathValue = process.env.PATH,
): string | null {
  const path = findUv(pathValue);
  if (!path) return `uv >=${ENVIRONMENT_UV_MIN_VERSION} was not found on PATH`;
  const version = readUvVersion(path);
  if (!version) return `could not read uv version from ${path}`;
  return isSupportedUvVersionOutput(version)
    ? null
    : `uv >=${ENVIRONMENT_UV_MIN_VERSION} is required, found ${version} at ${path}`;
}

let cached: UvToolStatus | null = null;

export function uvToolStatus(): UvToolStatus {
  if (cached) return cached;
  const path = findUv();
  if (!path) {
    cached = { available: false, path: null, version: null };
    return cached;
  }
  const version = readUvVersion(path);
  cached = {
    available: Boolean(version && isSupportedUvVersionOutput(version)),
    path,
    version,
  };
  return cached;
}

export function resetUvToolStatusCache() {
  cached = null;
}
