import {
  hfContentOid,
  parseSplitInfo,
  splitShardName,
  splitShardNames,
  type HfRepoBrowse,
  type ModelImportRequest,
  type ModelImportState,
} from "@arriero/core";
import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { safetensorsIndexShards } from "../models/safetensors.js";
import { isPathWithin } from "../path-utils.js";
import { importPathRank, matchImportGroup } from "./import-matching.js";
import type { VerificationObserver } from "./content-hash.js";
import {
  hashImportFile,
  importFileIdentity,
  statImportFile,
} from "./import-content.js";
import {
  type HfManifestFile,
  HF_MANIFEST_FILENAME,
  hfManifestFileFromTree,
} from "./manifest.js";
import {
  defaultHfDestDir,
  HfDownloadRequestError,
  isModelFilePath,
  resolveWithin,
  sanitizeRepoRelativePath,
  isInsideScanRoots,
} from "./paths.js";

export const IMPORT_STAGING_PREFIX = ".arriero-import-";

export type ImportRepositoryFiles = Pick<
  HfRepoBrowse,
  "repoId" | "commitSha" | "files"
> & { truncated?: boolean };

export type ImportSourceFile = {
  path: string;
  relative: string;
  size: number;
  identity: string;
};
export type ModelImportPlan = {
  source: string;
  directory: boolean;
  destinationRoot: string;
  files: ImportSourceFile[];
  manifestFiles: HfManifestFile[];
  state: ModelImportState;
};

export async function collectImportFiles(
  source: string,
  directory: boolean,
): Promise<ImportSourceFile[]> {
  const paths: string[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 16 || paths.length >= 10000)
      throw new HfDownloadRequestError(
        "Import directory is too large or too deep",
      );
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), depth + 1);
    } else if (info.isFile()) {
      if (
        basename(path) === HF_MANIFEST_FILENAME ||
        basename(path).startsWith(IMPORT_STAGING_PREFIX)
      )
        throw new HfDownloadRequestError(
          `Directory already contains arriero metadata: ${path}`,
        );
      paths.push(path);
    } else
      throw new HfDownloadRequestError(
        `Import requires regular files; symbolic links and special files are not supported: ${path}`,
      );
  };
  if (directory) await walk(source, 0);
  else {
    const split = parseSplitInfo(basename(source));
    if (split)
      paths.push(
        ...splitShardNames(split).map((name) => join(dirname(source), name)),
      );
    else paths.push(source);
  }
  const files: ImportSourceFile[] = [];
  for (const path of paths) {
    const { size, identity } = await statImportFile(path);
    files.push({
      path,
      relative: relative(directory ? source : dirname(source), path),
      size,
      identity,
    });
  }
  return files;
}

export async function planModelImport(input: {
  request: ModelImportRequest;
  state: ModelImportState;
  remote: ImportRepositoryFiles;
  files: ImportSourceFile[];
  destDir?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: VerificationObserver | undefined;
}): Promise<ModelImportPlan> {
  const { request, state, remote, files, signal, onProgress } = input;
  const source = resolve(request.sourcePath);
  if ((await realpath(source)) !== source)
    throw new HfDownloadRequestError(
      "Import the original path, not a symbolic link",
    );
  const directory = request.scope === "directory";
  if ((await lstat(source)).isDirectory() !== directory)
    throw new HfDownloadRequestError(
      "Source does not match the selected import scope",
    );
  if (!directory && !source.toLowerCase().endsWith(".gguf"))
    throw new HfDownloadRequestError(
      "Individual file import supports GGUF only",
    );
  const destDir = resolve(input.destDir ?? defaultHfDestDir(remote.repoId));
  if (!isInsideScanRoots(destDir))
    throw new HfDownloadRequestError(
      "Destination must be inside a model scan directory",
    );
  if (
    directory &&
    source !== destDir &&
    (isPathWithin(source, destDir) || isPathWithin(destDir, source))
  )
    throw new HfDownloadRequestError(
      "Source and destination directories must not contain one another",
    );
  if (!files.some((file) => isModelFilePath(file.path)))
    throw new HfDownloadRequestError("No model weights in this directory");
  if (remote.truncated)
    throw new HfDownloadRequestError(
      "Repository listing is incomplete; import cannot verify this repository",
    );
  Object.assign(state, {
    sourcePath: source,
    destDir,
    repoId: remote.repoId,
    revision: remote.commitSha,
    total: files.length,
  });
  const remotePath = request.remotePath
    ? sanitizeRepoRelativePath(request.remotePath)
    : "";
  const remoteSplit = parseSplitInfo(remotePath);
  const groupMatches = directory
    ? null
    : await matchImportGroup(
        files,
        remote.files.filter(
          (entry) =>
            !remotePath ||
            entry.path === remotePath ||
            (remoteSplit &&
              parseSplitInfo(entry.path)?.prefix === remoteSplit.prefix),
        ),
        signal,
        onProgress,
      );
  const remoteByPath = new Map(
    remote.files.map((entry) => [entry.path, [entry]]),
  );
  const manifestFiles: HfManifestFile[] = [];
  const destinations = new Set<string>();
  for (const [fileIndex, file] of files.entries()) {
    signal?.throwIfAborted();
    state.currentFile = file.relative;
    const expected = remotePath
      ? `${remotePath}/${file.relative}`
      : file.relative;
    let candidates = directory
      ? (remoteByPath.get(expected) ?? [])
      : groupMatches![fileIndex]!;
    if (!directory && remotePath) {
      const split = parseSplitInfo(basename(remotePath));
      const localSplit = parseSplitInfo(basename(file.path));
      const target =
        split && localSplit
          ? join(
              dirname(remotePath),
              splitShardName(split, localSplit.index, split.count),
            )
          : remotePath;
      candidates = candidates.filter((entry) => entry.path === target);
    }
    const hashes = new Map<boolean, string>();
    const matches = [];
    for (const candidate of candidates) {
      if (candidate.size !== file.size) continue;
      const lfs = candidate.lfs !== null;
      let hash = hashes.get(lfs);
      if (!hash) {
        hash = await hashImportFile(
          file.path,
          file.size,
          lfs,
          signal,
          onProgress,
        );
        hashes.set(lfs, hash);
      }
      if (hash === hfContentOid(candidate)) matches.push(candidate);
    }
    if ((await importFileIdentity(file.path)) !== file.identity)
      throw new HfDownloadRequestError(
        `File changed during verification: ${file.path}`,
      );
    if (directory)
      matches.sort(
        (a, b) =>
          importPathRank(a.path, file) - importPathRank(b.path, file) ||
          a.path.localeCompare(b.path),
      );
    const matched = matches[0];
    if (
      !matched &&
      (!directory || candidates.length > 0 || isModelFilePath(file.path))
    )
      throw new HfDownloadRequestError(
        `No matching content in the repository: ${file.relative}`,
      );
    const destination = matched?.path ?? expected;
    sanitizeRepoRelativePath(destination);
    if (destinations.has(destination))
      throw new HfDownloadRequestError(
        `Multiple source files map to ${destination}`,
      );
    destinations.add(destination);
    if (matched) manifestFiles.push(hfManifestFileFromTree(matched));
    state.files.push({
      source: file.path,
      destination: resolveWithin(destDir, destination),
      size: file.size,
      verified: Boolean(matched),
      ...(matches.length > 1
        ? {
            alternatives: matches.map((match) =>
              resolveWithin(destDir, match.path),
            ),
          }
        : {}),
    });
    state.completed++;
  }
  for (const file of manifestFiles) {
    const split = parseSplitInfo(basename(file.path));
    if (!split) continue;
    for (const name of splitShardNames(split)) {
      const shard = join(dirname(file.path), name);
      if (!destinations.has(shard))
        throw new HfDownloadRequestError(`Missing GGUF shard: ${shard}`);
    }
  }
  const relatives = new Set(files.map((file) => file.relative));
  for (const file of files) {
    const match = /^(.*-)(\d{5})-of-(\d{5})(\.safetensors)$/i.exec(
      file.relative,
    );
    if (!match) continue;
    const count = Number(match[3]);
    if (count < 1 || count > 10000)
      throw new HfDownloadRequestError(`Invalid shard count: ${file.relative}`);
    for (let index = 1; index <= count; index++) {
      const shard = `${match[1]}${String(index).padStart(5, "0")}-of-${match[3]}${match[4]}`;
      if (!relatives.has(shard))
        throw new HfDownloadRequestError(`Missing safetensors shard: ${shard}`);
    }
  }
  const localPaths = new Set(files.map((file) => file.path));
  for (const file of files.filter((entry) =>
    entry.relative.endsWith(".safetensors.index.json"),
  )) {
    const shards = safetensorsIndexShards(
      JSON.parse(await readFile(file.path, "utf8")),
    );
    if (!shards)
      throw new HfDownloadRequestError(
        `Invalid safetensors index: ${file.relative}`,
      );
    for (const shard of shards) {
      if (
        typeof shard !== "string" ||
        !localPaths.has(
          resolveWithin(dirname(file.path), sanitizeRepoRelativePath(shard)),
        )
      )
        throw new HfDownloadRequestError(
          `Missing safetensors shard in ${file.relative}: ${String(shard)}`,
        );
    }
  }
  const extras = state.files.filter((file) => !file.verified).length;
  if (extras)
    state.warnings.push(
      `${extras} local companion files will be preserved without a verified Hugging Face source.`,
    );
  return {
    source,
    directory,
    destinationRoot:
      directory && remotePath ? resolveWithin(destDir, remotePath) : destDir,
    files,
    manifestFiles,
    state,
  };
}
