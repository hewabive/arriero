import type { HfDownloadStart, HfLfsInfo } from "@arriero/core";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { formatGib } from "../utils/format.js";
import { partialBytesFor } from "./chunk-store.js";
import {
  fetchHfPathsInfo,
  fetchHfRepoInfo,
  type HfClientOptions,
} from "./client.js";
import {
  defaultHfDestDir,
  freeBytesForDir,
  HfDownloadRequestError,
  resolveWithin,
  sanitizeRepoRelativePath,
  splitHfRepoId,
} from "./paths.js";

const HEADROOM_BYTES = 256 * 1024 * 1024;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export class HfDownloadConflictError extends Error {}

export type HfPlannedFile = {
  path: string;
  size: number;
  oid: string;
  lfs: HfLfsInfo | null;
  lastCommitId: string | null;
  lastCommitDate: string | null;
  finalPath: string;
  partPath: string;
};

export type HfDownloadPlan = {
  repoId: string;
  destDir: string;
  sha: string;
  planned: HfPlannedFile[];
  totalBytes: number;
};

export type FreeBytesImpl = (dir: string) => Promise<number | null>;

export function plannedFileFor(
  destDir: string,
  file: {
    path: string;
    size: number;
    oid: string;
    lfs: HfLfsInfo | null;
    lastCommitId: string | null;
    lastCommitDate: string | null;
  },
): HfPlannedFile {
  const finalPath = resolveWithin(destDir, file.path);
  return {
    path: file.path,
    size: file.size,
    oid: file.oid,
    lfs: file.lfs,
    lastCommitId: file.lastCommitId,
    lastCommitDate: file.lastCommitDate,
    finalPath,
    partPath: `${finalPath}.part`,
  };
}

function presentBytesFor(planned: readonly HfPlannedFile[]): number {
  return planned.reduce((sum, file) => {
    if (
      existsSync(file.finalPath) &&
      statSync(file.finalPath).size === file.size
    ) {
      return sum + file.size;
    }
    return sum + Math.min(partialBytesFor(file.finalPath), file.size);
  }, 0);
}

export async function hfDownloadSpaceError(
  planned: readonly HfPlannedFile[],
  destDir: string,
  freeBytesImpl?: FreeBytesImpl,
): Promise<string | null> {
  const totalBytes = planned.reduce((sum, file) => sum + file.size, 0);
  const requiredBytes = totalBytes - presentBytesFor(planned) + HEADROOM_BYTES;
  const freeBytes = await (freeBytesImpl ?? freeBytesForDir)(destDir);
  if (freeBytes !== null && freeBytes < requiredBytes) {
    return `not enough free space in ${destDir}: need ${formatGib(requiredBytes)}, have ${formatGib(freeBytes)}`;
  }
  return null;
}

export async function planHfDownload(
  input: HfDownloadStart,
  clientOptions: HfClientOptions,
  freeBytesImpl?: FreeBytesImpl,
): Promise<HfDownloadPlan> {
  const repoId = input.repoId;
  splitHfRepoId(repoId);
  const relPaths = [...new Set(input.paths.map(sanitizeRepoRelativePath))];
  const destDir = resolve(input.destDir ?? defaultHfDestDir(repoId));
  const revisionInput = input.revision ?? "main";
  const sha = COMMIT_SHA_PATTERN.test(revisionInput)
    ? revisionInput.toLowerCase()
    : (await fetchHfRepoInfo(repoId, revisionInput, clientOptions)).sha;
  const upstream = await fetchHfPathsInfo(
    repoId,
    sha,
    relPaths,
    true,
    clientOptions,
  );
  const planned: HfPlannedFile[] = [];
  const missing: string[] = [];
  for (const path of relPaths) {
    const info = upstream.get(path);
    if (!info) {
      missing.push(path);
      continue;
    }
    planned.push(
      plannedFileFor(destDir, {
        path,
        size: info.size,
        oid: info.oid,
        lfs: info.lfs,
        lastCommitId: info.lastCommitId,
        lastCommitDate: info.lastCommitDate,
      }),
    );
  }
  if (missing.length > 0) {
    throw new HfDownloadRequestError(
      `paths not found in ${repoId}@${sha.slice(0, 12)}: ${missing
        .slice(0, 5)
        .join(", ")}${missing.length > 5 ? "…" : ""}`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  const spaceError = await hfDownloadSpaceError(
    planned,
    destDir,
    freeBytesImpl,
  );
  if (spaceError) {
    throw new HfDownloadConflictError(spaceError);
  }
  return {
    repoId,
    destDir,
    sha,
    planned,
    totalBytes: planned.reduce((sum, file) => sum + file.size, 0),
  };
}
