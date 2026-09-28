import {
  classifyGgufArtifactKind,
  groupGgufFiles,
  type ModelImportRelatedFile,
  type ModelImportState,
} from "@arriero/core";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  collectImportFiles,
  type ImportSourceFile,
  type ImportRepositoryFiles,
  type ModelImportPlan,
} from "./model-import-plan.js";
import { matchImportGroup } from "./import-matching.js";
import { hfManifestFileFromTree, type HfManifestFile } from "./manifest.js";
import { isInsideScanRoots, resolveWithin } from "./paths.js";

const SKIPPED_NEIGHBOR_FILE =
  /\.(?:part|partial|lock|safetensors|bin|pt|pth)$/i;

export type ImportRelatedFile = {
  file: ModelImportRelatedFile;
  source: ImportSourceFile;
  manifest: HfManifestFile;
};

export type NeighborPathCache = Map<string, string[]>;

async function projectedPaths(
  plan: ModelImportPlan,
  remote: ImportRepositoryFiles,
  state: ModelImportState,
  signal: AbortSignal,
): Promise<string[]> {
  const directory = dirname(plan.source);
  const roots = new Set([directory]);
  for (const file of plan.state.files) {
    for (const destination of file.alternatives ?? [file.destination]) {
      const repoPath = relative(plan.state.destDir, destination);
      const depth = repoPath.split("/").length - 1;
      if (depth > 2) continue;
      let root = dirname(file.source);
      for (let level = 0; level < depth; level++) root = dirname(root);
      if (
        dirname(root) === root ||
        (isInsideScanRoots(directory) && !isInsideScanRoots(root))
      )
        continue;
      roots.add(root);
    }
  }
  const paths = new Set<string>();
  let checked = 0;
  for (const root of roots) {
    for (const file of remote.files) {
      signal.throwIfAborted();
      if (++checked > 2000) {
        state.searchTruncated = true;
        return [...paths];
      }
      if (
        file.path.split("/").some((part) => part.startsWith(".")) ||
        SKIPPED_NEIGHBOR_FILE.test(file.path)
      )
        continue;
      const path = resolveWithin(root, file.path);
      if (
        path.startsWith(`${plan.state.destDir}/`) &&
        !plan.source.startsWith(`${plan.state.destDir}/`)
      )
        continue;
      try {
        const info = await lstat(path);
        if (
          info.isFile() &&
          info.size === file.size &&
          (await realpath(path)) === path
        )
          paths.add(path);
      } catch (error) {
        signal.throwIfAborted();
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        state.warnings.push(
          `Could not inspect projected file ${path}: ${(error as Error).message}`,
        );
      }
    }
  }
  return [...paths];
}

async function neighboringPaths(
  plan: ModelImportPlan,
  state: ModelImportState,
  signal: AbortSignal,
): Promise<string[]> {
  const directory = dirname(plan.source);
  const parent = dirname(directory);
  const ascend =
    parent !== directory &&
    dirname(parent) !== parent &&
    (!isInsideScanRoots(directory) || isInsideScanRoots(parent));
  const root = ascend ? parent : directory;
  const queue = [{ path: directory, depth: ascend ? 1 : 0 }];
  if (ascend) queue.push({ path: parent, depth: 0 });
  const visited = new Set<string>();
  const paths: string[] = [];
  let entries = 0;
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    if (visited.has(item.path)) continue;
    if (visited.size >= 64) {
      state.searchTruncated = true;
      break;
    }
    visited.add(item.path);
    try {
      if ((await realpath(item.path)) !== item.path) continue;
      for await (const entry of await opendir(item.path)) {
        signal.throwIfAborted();
        if (++entries > 2000) {
          state.searchTruncated = true;
          return paths;
        }
        if (entry.name.startsWith(".")) continue;
        const path = resolve(item.path, entry.name);
        if (path === plan.state.destDir && path !== directory && path !== root)
          continue;
        if (entry.isDirectory()) {
          if (item.depth < 2) queue.push({ path, depth: item.depth + 1 });
          else state.searchTruncated = true;
        } else if (entry.isFile() && !SKIPPED_NEIGHBOR_FILE.test(entry.name))
          paths.push(path);
      }
    } catch (error) {
      signal.throwIfAborted();
      state.warnings.push(
        `Could not inspect neighboring directory ${item.path}: ${(error as Error).message}`,
      );
    }
  }
  return paths;
}

async function cachedNeighboringPaths(
  plan: ModelImportPlan,
  state: ModelImportState,
  signal: AbortSignal,
  cache: NeighborPathCache,
): Promise<string[]> {
  const key = `${plan.source}\0${plan.state.destDir}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const paths = await neighboringPaths(plan, state, signal);
  cache.set(key, paths);
  return paths;
}

export async function discoverRelatedFiles(
  plan: ModelImportPlan,
  remote: ImportRepositoryFiles,
  state: ModelImportState,
  signal: AbortSignal,
  neighborCache: NeighborPathCache,
): Promise<ImportRelatedFile[]> {
  if (plan.directory) return [];
  const required = new Set(plan.files.map((file) => file.path));
  const projected = await projectedPaths(plan, remote, state, signal);
  const nearby = await cachedNeighboringPaths(
    plan,
    state,
    signal,
    neighborCache,
  );
  const paths = [...new Set([...projected, ...nearby])].filter(
    (path) => !required.has(path),
  );
  const result: ImportRelatedFile[] = [];
  for (const group of groupGgufFiles(paths, (path) => path)) {
    signal.throwIfAborted();
    if (!group.complete) continue;
    const path = group.files[0]!;
    const gguf = path.toLowerCase().endsWith(".gguf");
    if (
      !gguf &&
      !remote.files.some((file) => basename(file.path) === basename(path))
    )
      continue;
    try {
      const sources = await collectImportFiles(path, false);
      state.currentFile = `Checking neighboring group: ${relative(dirname(plan.source), path)}`;
      const matches = await matchImportGroup(
        sources,
        remote.files,
        signal,
        (progress) => {
          state.verification = progress;
        },
      );
      if (matches.some((files) => !files.length)) continue;
      if (result.length + sources.length > 200) {
        state.searchTruncated = true;
        break;
      }
      for (const [index, source] of sources.entries()) {
        const relativePath = relative(dirname(plan.source), source.path);
        state.currentFile = `Checking neighboring file: ${relativePath}`;
        const matched = matches[index]!;
        const selected = matched[0]!;
        result.push({
          source: { ...source, relative: relativePath },
          file: {
            source: source.path,
            relativePath,
            destination: resolveWithin(plan.state.destDir, selected.path),
            size: source.size,
            verified: true,
            kind:
              gguf && classifyGgufArtifactKind(basename(path)) === "model"
                ? "variant"
                : "companion",
            alternatives: matched.map((file) =>
              resolveWithin(plan.state.destDir, file.path),
            ),
          },
          manifest: hfManifestFileFromTree(selected),
        });
      }
    } catch (error) {
      signal.throwIfAborted();
      state.warnings.push(
        `Could not verify neighboring group ${path}: ${(error as Error).message}`,
      );
    }
  }
  return result;
}
