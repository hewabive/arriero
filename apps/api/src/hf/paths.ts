import type { HfDestCheck } from "@arriero/core";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { logger } from "../logger.js";
import { getModelScanSettings } from "../models/cache-repository.js";
import { listModelScanRoots } from "../models/roots.js";
import { capacityFromStatFs } from "../system/storage-space.js";

export class HfDownloadRequestError extends Error {}

export function splitHfRepoId(repoId: string): { owner: string; repo: string } {
  const segments = repoId.split("/");
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo || segments.length !== 2) {
    throw new HfDownloadRequestError(`invalid HuggingFace repo id: ${repoId}`);
  }
  return { owner, repo };
}

export function defaultHfDestDir(repoId: string): string {
  const { owner, repo } = splitHfRepoId(repoId);
  return join(getModelScanSettings().directory, owner, repo);
}

export function sanitizeRepoRelativePath(path: string): string {
  if (path.includes("\\") || path.startsWith("/")) {
    throw new HfDownloadRequestError(`invalid repo file path: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new HfDownloadRequestError(`invalid repo file path: ${path}`);
  }
  return segments.join("/");
}

export function resolveWithin(baseDir: string, relativePath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HfDownloadRequestError(
      `repo file path escapes the destination directory: ${relativePath}`,
    );
  }
  return target;
}

export function isInsideScanRoots(dir: string): boolean {
  const resolved = resolve(dir);
  return listModelScanRoots().some(
    (root) => resolved === root.path || resolved.startsWith(root.path + sep),
  );
}

function nearestExistingDir(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

export async function freeBytesForDir(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(nearestExistingDir(dir), { bigint: true });
    return capacityFromStatFs(stats).freeBytes;
  } catch (error) {
    logger.warn({ dir, err: error }, "failed to read free space for hf dest");
    return null;
  }
}

export async function hfDestCheck(dir: string): Promise<HfDestCheck> {
  const resolved = resolve(dir);
  return {
    dir: resolved,
    insideScanRoots: isInsideScanRoots(resolved),
    freeBytes: await freeBytesForDir(resolved),
  };
}
