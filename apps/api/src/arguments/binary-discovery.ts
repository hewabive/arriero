import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config.js";
import { getBuildSettings, listBuildJobs } from "../build/repository.js";
import { listPathCatalogEntries } from "../path-catalog/repository.js";

export function defaultBinaryPath() {
  const settings = getBuildSettings();
  const target =
    process.platform === "win32" && !settings.target.endsWith(".exe")
      ? `${settings.target}.exe`
      : settings.target;

  const masterCandidate = resolve(settings.buildDir, "master", "bin", target);
  if (existsSync(masterCandidate)) {
    return masterCandidate;
  }

  const catalogBinary = listPathCatalogEntries("binary")
    .filter((entry) => existsSync(entry.path))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (catalogBinary) {
    return catalogBinary.path;
  }

  const latestWithBinary = listBuildJobs(20).find(
    (job) => job.binaryPath && existsSync(job.binaryPath),
  );
  if (latestWithBinary?.binaryPath) {
    return latestWithBinary.binaryPath;
  }

  const reffdevCandidate = resolve(
    config.rootDir,
    "..",
    "llama.cpp",
    "build-reffdev",
    "bin",
    target,
  );
  if (existsSync(reffdevCandidate)) {
    return reffdevCandidate;
  }

  return masterCandidate;
}

const execFileAsync = promisify(execFile);

function helpEnvironment(binaryPath: string) {
  const binaryDir = dirname(binaryPath);
  const libraryPathName =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const libraryPath = [binaryDir, process.env[libraryPathName]]
    .filter(Boolean)
    .join(process.platform === "win32" ? ";" : ":");
  return { ...process.env, [libraryPathName]: libraryPath };
}

export async function runHelpAsync(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
) {
  if (!existsSync(binaryPath)) {
    throw new Error(`engine binary not found: ${binaryPath}`);
  }
  const { stdout } = await execFileAsync(binaryPath, args, {
    env: helpEnvironment(binaryPath),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return stdout;
}

export function binaryStat(binaryPath: string) {
  const stat = statSync(binaryPath);
  return {
    binarySize: stat.size,
    binaryMtimeMs: String(stat.mtimeMs),
    binaryModifiedAt: stat.mtime.toISOString(),
  };
}
