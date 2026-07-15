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

export function uvPythonPreflightCommand(uv: string, pythonVersion: string) {
  return [
    uv,
    "python",
    "find",
    "--no-project",
    "--managed-python",
    "--no-python-downloads",
    "--show-version",
    pythonVersion,
  ];
}

export function assertUvPythonAvailable(uv: string, pythonVersion: string) {
  const [command, ...args] = uvPythonPreflightCommand(uv, pythonVersion);
  try {
    execFileSync(command!, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch {
    throw new Error(
      `Python ${pythonVersion} is not installed in uv; import or install that runtime before starting an offline environment installation`,
    );
  }
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
