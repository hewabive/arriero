import type {
  HfDownloadedRepo,
  HfDownloadedRepoFile,
  HfUpdateCheck,
} from "@arriero/core";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getActiveJob } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { getModelScanSettings } from "../models/cache-repository.js";
import { listModelScanRoots } from "../models/roots.js";
import { IGNORED_DIRS } from "../models/scanner.js";
import { isPathWithin } from "../path-utils.js";
import { startModelScan } from "../models/scan-runner.js";
import { traceBlockingSection } from "../system/event-loop.js";
import type { HfClientOptions } from "./client.js";
import { groupHfGgufFiles } from "./grouping.js";
import { hfDeleteBlockers, listLiveProcessArgs } from "./in-use.js";
import {
  HF_MANIFEST_FILENAME,
  readHfManifest,
  writeHfManifest,
  type HfManifest,
} from "./manifest.js";
import {
  isInsideScanRoots,
  resolveWithin,
  sanitizeRepoRelativePath,
} from "./paths.js";
import {
  clearHfUpdateCheck,
  getHfUpdateCheck,
  pruneHfUpdateCheckFiles,
  runHfUpdateChecks,
} from "./update-check.js";

export const HF_DOWNLOAD_JOB_DOMAIN = "hf-download";

const CACHE_TTL_MS = 30_000;
const MAX_VISITED_DIRS = 5_000;

export class HfDownloadNotFoundError extends Error {}
export class HfDownloadBusyError extends Error {}
export class HfDownloadVerifyError extends Error {
  readonly verification: HfUpdateCheck;

  constructor(message: string, verification: HfUpdateCheck) {
    super(message);
    this.verification = verification;
  }
}

type DiscoveredRepo = {
  dir: string;
  manifest: HfManifest;
};

let cache: { key: string; at: number; repos: DiscoveredRepo[] } | null = null;

export function invalidateHfDownloadsCache(): void {
  cache = null;
}

async function collectManifestDirs(
  dir: string,
  maxDepth: number,
  state: { visited: number },
  out: string[],
  depth = 0,
): Promise<void> {
  if (state.visited >= MAX_VISITED_DIRS) {
    return;
  }
  state.visited += 1;
  if (existsSync(join(dir, HF_MANIFEST_FILENAME))) {
    out.push(dir);
    return;
  }
  if (depth >= maxDepth) {
    return;
  }
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  for await (const entry of handle) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    await collectManifestDirs(
      join(dir, entry.name),
      maxDepth,
      state,
      out,
      depth + 1,
    );
  }
}

async function discoverRepos(): Promise<DiscoveredRepo[]> {
  const roots = listModelScanRoots().filter((root) => root.exists);
  const maxDepth = getModelScanSettings().maxDepth;
  const dirs: string[] = [];
  const state = { visited: 0 };
  for (const root of roots) {
    await collectManifestDirs(root.path, maxDepth, state, dirs);
  }
  if (state.visited >= MAX_VISITED_DIRS) {
    logger.warn(
      { visited: state.visited },
      "hf download discovery hit the directory cap; some downloads may be missing",
    );
  }
  const repos: DiscoveredRepo[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const manifest = readHfManifest(resolved);
    if (manifest) {
      repos.push({ dir: resolved, manifest });
    }
  }
  return repos.sort((a, b) =>
    a.manifest.repoId.localeCompare(b.manifest.repoId),
  );
}

export async function listHfDownloads(): Promise<HfDownloadedRepo[]> {
  const key = listModelScanRoots()
    .map((root) => root.path)
    .join("\0");
  if (!cache || cache.key !== key || Date.now() - cache.at > CACHE_TTL_MS) {
    cache = { key, at: Date.now(), repos: await discoverRepos() };
  }
  return cache.repos.map(({ dir, manifest }) => {
    const files: HfDownloadedRepoFile[] = manifest.files.map((file) => ({
      path: file.path,
      size: file.size,
      oid: file.oid,
      lfsOid: file.lfsOid,
      present: existsSync(join(dir, file.path)),
    }));
    return {
      dir,
      repoId: manifest.repoId,
      revision: manifest.revision,
      downloadedAt: manifest.downloadedAt,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      missingFiles: files.filter((file) => !file.present).length,
      files,
      variants: groupHfGgufFiles(manifest.files),
      update: getHfUpdateCheck(dir),
    };
  });
}

function resolveDeletableHfDownload(dir: string): {
  resolved: string;
  manifest: HfManifest;
} {
  const resolved = resolve(dir);
  const manifest = readHfManifest(resolved);
  if (!manifest || !isInsideScanRoots(resolved)) {
    throw new HfDownloadNotFoundError(
      `no downloaded HuggingFace repo at ${resolved}`,
    );
  }
  if (getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, manifest.repoId)) {
    throw new HfDownloadBusyError(
      `a download for ${manifest.repoId} is running; cancel it first`,
    );
  }
  return { resolved, manifest };
}

function resolveManifestDeletePaths(
  manifest: HfManifest,
  paths: readonly string[],
): string[] {
  const known = new Set(manifest.files.map((file) => file.path));
  const targets = [...new Set(paths)];
  const unknown = targets.filter((path) => !known.has(path));
  if (unknown.length > 0) {
    throw new HfDownloadNotFoundError(
      `not in the download manifest: ${unknown.join(", ")}`,
    );
  }
  return targets;
}

function pruneEmptyDirsWithin(baseDir: string, start: string): void {
  let current = start;
  while (current !== baseDir && isPathWithin(baseDir, current)) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    rmSync(current, { recursive: true, force: true });
    current = dirname(current);
  }
}

function removeHfDownloadDir(resolved: string): void {
  traceBlockingSection("hf:rm-download", () =>
    rmSync(resolved, { recursive: true, force: true }),
  );
  const parent = dirname(resolved);
  const strictlyInsideRoot = listModelScanRoots().some(
    (root) => parent !== root.path && isPathWithin(root.path, parent),
  );
  if (strictlyInsideRoot && readdirSync(parent).length === 0) {
    rmSync(parent, { recursive: true, force: true });
  }
}

function removeHfDownloadFiles(
  resolved: string,
  manifest: HfManifest,
  targets: readonly string[],
): void {
  const targetSet = new Set(targets);
  traceBlockingSection("hf:rm-download-files", () => {
    for (const path of targets) {
      const absolute = resolveWithin(resolved, sanitizeRepoRelativePath(path));
      rmSync(absolute, { force: true });
      rmSync(`${absolute}.part`, { force: true });
      pruneEmptyDirsWithin(resolved, dirname(absolute));
    }
  });
  writeHfManifest(resolved, {
    ...manifest,
    files: manifest.files.filter((file) => !targetSet.has(file.path)),
  });
}

export function deleteHfDownload(dir: string, paths?: readonly string[]): void {
  const { resolved, manifest } = resolveDeletableHfDownload(dir);
  const targets = paths ? resolveManifestDeletePaths(manifest, paths) : null;
  const partialDelete =
    targets !== null && targets.length < manifest.files.length;
  const blockers = hfDeleteBlockers(
    { dir: resolved, paths: partialDelete ? targets : null },
    listLiveProcessArgs(),
  );
  if (blockers.length > 0) {
    throw new HfDownloadBusyError(
      `${manifest.repoId} is in use by running instances: ${blockers.join(", ")}; stop them first`,
    );
  }
  if (partialDelete) {
    removeHfDownloadFiles(resolved, manifest, targets);
    pruneHfUpdateCheckFiles(resolved, new Set(targets));
  } else {
    removeHfDownloadDir(resolved);
    clearHfUpdateCheck(resolved);
  }
  invalidateHfDownloadsCache();
  startModelScan({ refresh: true });
}

export async function verifyHfDownloadRedownloadable(
  dir: string,
  paths?: readonly string[],
  options?: HfClientOptions,
): Promise<void> {
  const { resolved, manifest } = resolveDeletableHfDownload(dir);
  const targets = paths
    ? new Set(resolveManifestDeletePaths(manifest, paths))
    : null;
  const check = (await runHfUpdateChecks([resolved], options))[resolved];
  if (!check || check.status === "error" || check.status === "unchecked") {
    throw new HfDownloadVerifyError(
      `could not verify ${manifest.repoId} on HuggingFace: ${check?.error ?? "no check result"}`,
      check ?? {
        status: "error",
        checkedAt: null,
        revisionSha: null,
        error: "no check result",
        files: [],
      },
    );
  }
  const gone = check.files.filter(
    (file) =>
      file.status === "deleted" && (targets === null || targets.has(file.path)),
  );
  if (gone.length > 0) {
    throw new HfDownloadVerifyError(
      `${manifest.repoId}: ${gone.length} of the files to delete no longer exist upstream and cannot be re-downloaded`,
      check,
    );
  }
}
