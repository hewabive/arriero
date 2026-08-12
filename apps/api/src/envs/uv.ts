import type { UvToolStatus } from "@arriero/core";
import { execFileSync } from "node:child_process";

import { findExecutableInPath } from "../system/tool-probe.js";

export type UvProbe =
  | { path: string; version: string; error: null }
  | { path: string | null; version: string | null; error: string };

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
      error: "uv was not found on PATH",
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
