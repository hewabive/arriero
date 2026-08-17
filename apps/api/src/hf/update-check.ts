import type { HfUpdateCheck, HfUpdateCheckFile } from "@arriero/core";
import { resolve } from "node:path";

import { logger } from "../logger.js";
import {
  fetchHfPathsInfo,
  fetchHfRepoInfo,
  HfHubError,
  type HfClientOptions,
} from "./client.js";
import { readHfManifest, type HfManifest } from "./manifest.js";

const checks = new Map<string, HfUpdateCheck>();

const UNCHECKED: HfUpdateCheck = {
  status: "unchecked",
  checkedAt: null,
  revisionSha: null,
  error: null,
  files: [],
};

export function getHfUpdateCheck(dir: string): HfUpdateCheck {
  return checks.get(resolve(dir)) ?? UNCHECKED;
}

export function clearHfUpdateCheck(dir: string): void {
  checks.delete(resolve(dir));
}

export function resetHfUpdateChecksForTests(): void {
  checks.clear();
}

export function diffHfManifest(
  manifest: HfManifest,
  upstream: Map<string, { oid: string; lfs: { oid: string } | null }>,
): { files: HfUpdateCheckFile[]; status: "in-sync" | "drift" } {
  const files = manifest.files.map((file): HfUpdateCheckFile => {
    const remote = upstream.get(file.path);
    if (!remote) {
      return { path: file.path, status: "deleted" };
    }
    const matches =
      file.lfsOid !== null && remote.lfs !== null
        ? file.lfsOid === remote.lfs.oid
        : file.oid === remote.oid;
    return { path: file.path, status: matches ? "current" : "updated" };
  });
  return {
    files,
    status: files.every((file) => file.status === "current")
      ? "in-sync"
      : "drift",
  };
}

async function runHfUpdateCheck(
  dir: string,
  options?: HfClientOptions,
): Promise<HfUpdateCheck> {
  const manifest = readHfManifest(dir);
  if (!manifest) {
    return {
      status: "error",
      checkedAt: new Date().toISOString(),
      revisionSha: null,
      error: "no download manifest found",
      files: [],
    };
  }
  try {
    const info = await fetchHfRepoInfo(manifest.repoId, "main", options);
    if (info.sha === manifest.revision) {
      return {
        status: "in-sync",
        checkedAt: new Date().toISOString(),
        revisionSha: info.sha,
        error: null,
        files: manifest.files.map((file) => ({
          path: file.path,
          status: "current",
        })),
      };
    }
    const upstream = await fetchHfPathsInfo(
      manifest.repoId,
      info.sha,
      manifest.files.map((file) => file.path),
      false,
      options,
    );
    const diff = diffHfManifest(manifest, upstream);
    return {
      status: diff.status,
      checkedAt: new Date().toISOString(),
      revisionSha: info.sha,
      error: null,
      files: diff.files,
    };
  } catch (error) {
    const message =
      error instanceof HfHubError
        ? error.message
        : `update check failed: ${(error as Error).message}`;
    logger.warn(
      { dir, repoId: manifest.repoId, err: error },
      "hf update check failed",
    );
    return {
      status: "error",
      checkedAt: new Date().toISOString(),
      revisionSha: null,
      error: message,
      files: [],
    };
  }
}

export async function runHfUpdateChecks(
  dirs: readonly string[],
  options?: HfClientOptions,
): Promise<Record<string, HfUpdateCheck>> {
  const result: Record<string, HfUpdateCheck> = {};
  for (const dir of dirs) {
    const resolved = resolve(dir);
    const check = await runHfUpdateCheck(resolved, options);
    checks.set(resolved, check);
    result[resolved] = check;
  }
  return result;
}
