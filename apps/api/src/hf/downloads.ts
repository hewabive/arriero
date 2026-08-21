import type {
  HfDownloadedRepo,
  HfDownloadedRepoFile,
  HfOrphanPart,
  HfUpdateCheck,
} from "@arriero/core";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { opendir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { getActiveJob } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { getModelScanSettings } from "../models/cache-repository.js";
import { listModelScanRoots } from "../models/roots.js";
import { IGNORED_DIRS } from "../models/scanner.js";
import { isPathWithin } from "../path-utils.js";
import { startModelScan } from "../models/scan-runner.js";
import { traceBlockingSection } from "../system/event-loop.js";
import { partialBytesFor } from "./chunk-store.js";
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
const ORPHAN_SCAN_MAX_ENTRIES = 500;
const ORPHAN_SCAN_MAX_DEPTH = 6;

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
  orphanParts: HfOrphanPart[];
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
      repos.push({
        dir: resolved,
        manifest,
        orphanParts: await collectOrphanParts(resolved, manifest),
      });
    }
  }
  return repos.sort((a, b) =>
    a.manifest.repoId.localeCompare(b.manifest.repoId),
  );
}

async function collectOrphanParts(
  dir: string,
  manifest: HfManifest,
): Promise<HfOrphanPart[]> {
  const known = new Set(manifest.files.map((file) => resolve(dir, file.path)));
  const out: HfOrphanPart[] = [];
  const state = { visited: 0 };
  const walk = async (current: string, depth: number): Promise<void> => {
    if (state.visited >= ORPHAN_SCAN_MAX_ENTRIES) {
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.visited >= ORPHAN_SCAN_MAX_ENTRIES) {
        return;
      }
      state.visited += 1;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          depth < ORPHAN_SCAN_MAX_DEPTH &&
          !IGNORED_DIRS.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          await walk(absolute, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".part")) {
        const finalAbsolute = absolute.slice(0, -".part".length);
        if (!known.has(finalAbsolute)) {
          out.push({
            path: relative(dir, absolute),
            partialBytes: partialBytesFor(finalAbsolute),
          });
        }
      } else if (entry.name.endsWith(".part.json")) {
        const partAbsolute = absolute.slice(0, -".json".length);
        const finalAbsolute = absolute.slice(0, -".part.json".length);
        if (!existsSync(partAbsolute) && !known.has(finalAbsolute)) {
          out.push({ path: relative(dir, absolute), partialBytes: 0 });
        }
      }
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listHfDownloads(): Promise<HfDownloadedRepo[]> {
  const key = listModelScanRoots()
    .map((root) => root.path)
    .join("\0");
  if (!cache || cache.key !== key || Date.now() - cache.at > CACHE_TTL_MS) {
    cache = { key, at: Date.now(), repos: await discoverRepos() };
  }
  return cache.repos.map(({ dir, manifest, orphanParts }) => {
    const files: HfDownloadedRepoFile[] = manifest.files.map((file) => {
      const finalPath = join(dir, file.path);
      const present = existsSync(finalPath);
      return {
        path: file.path,
        size: file.size,
        oid: file.oid,
        lfsOid: file.lfsOid,
        present,
        partialBytes: present
          ? 0
          : Math.min(partialBytesFor(finalPath), file.size),
      };
    });
    return {
      dir,
      repoId: manifest.repoId,
      revision: manifest.revision,
      downloadedAt: manifest.downloadedAt,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      missingFiles: files.filter((file) => !file.present).length,
      files,
      orphanParts,
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
  if (getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, resolved)) {
    throw new HfDownloadBusyError(
      `a download into ${resolved} is running; cancel it first`,
    );
  }
  return { resolved, manifest };
}

type HfDeleteTargets = {
  manifestPaths: string[];
  orphanPaths: string[];
};

function splitHfDeleteTargets(
  resolved: string,
  manifest: HfManifest,
  paths: readonly string[],
): HfDeleteTargets {
  const known = new Set(manifest.files.map((file) => file.path));
  const manifestPaths: string[] = [];
  const orphanPaths: string[] = [];
  const unknown: string[] = [];
  for (const path of [...new Set(paths)]) {
    if (known.has(path)) {
      manifestPaths.push(path);
      continue;
    }
    if (
      (path.endsWith(".part") || path.endsWith(".part.json")) &&
      existsSync(resolveWithin(resolved, sanitizeRepoRelativePath(path)))
    ) {
      orphanPaths.push(path);
      continue;
    }
    unknown.push(path);
  }
  if (unknown.length > 0) {
    throw new HfDownloadNotFoundError(
      `not in the download manifest: ${unknown.join(", ")}`,
    );
  }
  return { manifestPaths, orphanPaths };
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
      rmSync(`${absolute}.part.json`, { force: true });
      pruneEmptyDirsWithin(resolved, dirname(absolute));
    }
  });
  writeHfManifest(resolved, {
    ...manifest,
    files: manifest.files.filter((file) => !targetSet.has(file.path)),
  });
}

function removeHfOrphanParts(
  resolved: string,
  orphanPaths: readonly string[],
): void {
  traceBlockingSection("hf:rm-orphan-parts", () => {
    for (const path of orphanPaths) {
      const absolute = resolveWithin(resolved, sanitizeRepoRelativePath(path));
      rmSync(absolute, { force: true });
      if (absolute.endsWith(".part")) {
        rmSync(`${absolute}.json`, { force: true });
      }
      pruneEmptyDirsWithin(resolved, dirname(absolute));
    }
  });
}

export function deleteHfDownload(dir: string, paths?: readonly string[]): void {
  const { resolved, manifest } = resolveDeletableHfDownload(dir);
  const targets = paths
    ? splitHfDeleteTargets(resolved, manifest, paths)
    : null;
  const fullDelete =
    targets === null ||
    (manifest.files.length > 0 &&
      targets.manifestPaths.length === manifest.files.length);
  const blockers = hfDeleteBlockers(
    {
      dir: resolved,
      paths: fullDelete ? null : (targets?.manifestPaths ?? null),
    },
    listLiveProcessArgs(),
  );
  if (blockers.length > 0) {
    throw new HfDownloadBusyError(
      `${manifest.repoId} is in use by running instances: ${blockers.join(", ")}; stop them first`,
    );
  }
  if (!fullDelete && targets) {
    if (targets.manifestPaths.length > 0) {
      removeHfDownloadFiles(resolved, manifest, targets.manifestPaths);
      pruneHfUpdateCheckFiles(resolved, new Set(targets.manifestPaths));
    }
    if (targets.orphanPaths.length > 0) {
      removeHfOrphanParts(resolved, targets.orphanPaths);
    }
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
    ? new Set(splitHfDeleteTargets(resolved, manifest, paths).manifestPaths)
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
