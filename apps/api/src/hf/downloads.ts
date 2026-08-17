import type { HfDownloadedRepo, HfDownloadedRepoFile } from "@arriero/core";
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
import { groupHfGgufFiles } from "./grouping.js";
import {
  HF_MANIFEST_FILENAME,
  readHfManifest,
  type HfManifest,
} from "./manifest.js";
import { isInsideScanRoots } from "./paths.js";
import { clearHfUpdateCheck, getHfUpdateCheck } from "./update-check.js";

export const HF_DOWNLOAD_JOB_DOMAIN = "hf-download";

const CACHE_TTL_MS = 30_000;
const MAX_VISITED_DIRS = 5_000;

export class HfDownloadNotFoundError extends Error {}
export class HfDownloadBusyError extends Error {}

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

export function deleteHfDownload(dir: string): void {
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
  clearHfUpdateCheck(resolved);
  invalidateHfDownloadsCache();
  startModelScan({ refresh: true });
}
