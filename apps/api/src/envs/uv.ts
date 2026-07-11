import type { UvToolStatus } from "@llama-manager/core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function findUv(pathValue = process.env.PATH): string | null {
  for (const directory of pathValue?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = resolve(directory, process.platform === "win32" ? "uv.exe" : "uv");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cached: UvToolStatus | null = null;

export function uvToolStatus(): UvToolStatus {
  if (cached) return cached;
  const path = findUv();
  if (!path) {
    cached = { available: false, path: null, version: null };
    return cached;
  }
  try {
    const output = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    cached = { available: true, path, version: output || null };
  } catch {
    cached = { available: false, path, version: null };
  }
  return cached;
}

export function resetUvToolStatusCache() {
  cached = null;
}
