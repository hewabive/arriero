import type { UvToolStatus } from "@arriero/core";

import { findExecutableInPath, readVersionSync } from "../system/tool-probe.js";

export type UvProbe =
  | { path: string; version: string; error: null }
  | { path: string | null; version: string | null; error: string };

export function probeUv(pathValue = process.env.PATH): UvProbe {
  const path = findExecutableInPath("uv", pathValue);
  if (!path) {
    return {
      path: null,
      version: null,
      error: "uv was not found on PATH",
    };
  }
  const version = readVersionSync(path, "uv");
  if (!version) {
    return {
      path,
      version: null,
      error: `could not read uv version from ${path}`,
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
