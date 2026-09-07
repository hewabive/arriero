import {
  parseHfRepoInput,
  parseSplitInfo,
  splitShardName,
  type ModelImportRequest,
  type ModelImportState,
} from "@arriero/core";
import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isPathWithin } from "../path-utils.js";
import { browseHfRepo } from "./browse.js";
import type { HfClientOptions } from "./client.js";
import { hashHfContentFile } from "./content-hash.js";
import { type HfManifestFile, HF_MANIFEST_FILENAME } from "./manifest.js";
import {
  defaultHfDestDir,
  HfDownloadRequestError,
  resolveWithin,
  sanitizeRepoRelativePath,
  isInsideScanRoots,
} from "./paths.js";

export type ImportSourceFile = {
  path: string;
  relative: string;
  size: number;
  identity: string;
};
export type ModelImportPlan = {
  source: string;
  directory: boolean;
  files: ImportSourceFile[];
  manifestFiles: HfManifestFile[];
  state: ModelImportState;
};

export async function importFileIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile())
    throw new HfDownloadRequestError(`Not a regular file: ${path}`);
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

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
        basename(path).startsWith(".arriero-import-")
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
    if (split) {
      for (let index = 1; index <= split.count; index++)
        paths.push(
          join(dirname(source), splitShardName(split, index, split.count)),
        );
    } else paths.push(source);
  }
  const files: ImportSourceFile[] = [];
  for (const path of paths) {
    const identity = await importFileIdentity(path);
    files.push({
      path,
      relative: relative(directory ? source : dirname(source), path),
      size: Number((await lstat(path)).size),
      identity,
    });
  }
  return files;
}

export async function planModelImport(
  input: ModelImportRequest,
  state: ModelImportState,
  options?: HfClientOptions,
  signal?: AbortSignal,
): Promise<ModelImportPlan> {
  const parsed = parseHfRepoInput(input.repo);
  if (!parsed)
    throw new HfDownloadRequestError(
      "Enter a Hugging Face repository ID or URL",
    );
  const source = resolve(input.sourcePath);
  if ((await realpath(source)) !== source)
    throw new HfDownloadRequestError(
      "Import the original path, not a symbolic link",
    );
  const directory = input.scope === "directory";
  if ((await lstat(source)).isDirectory() !== directory)
    throw new HfDownloadRequestError(
      "Source does not match the selected import scope",
    );
  if (!directory && !source.toLowerCase().endsWith(".gguf"))
    throw new HfDownloadRequestError(
      "Individual file import supports GGUF only",
    );
  const destDir = resolve(defaultHfDestDir(parsed.repoId));
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
  const files = await collectImportFiles(source, directory);
  if (!files.some((file) => /\.(gguf|safetensors)$/i.test(file.path)))
    throw new HfDownloadRequestError("No model weights in this directory");
  const remote = await browseHfRepo(
    { repoId: parsed.repoId, revision: parsed.revision ?? input.revision },
    options,
  );
  if (remote.truncated)
    throw new HfDownloadRequestError(
      "Repository listing is incomplete; import cannot verify this repository",
    );
  Object.assign(state, {
    sourcePath: source,
    destDir,
    repoId: parsed.repoId,
    revision: remote.commitSha,
    total: files.length,
  });
  const remotePath = input.remotePath
    ? sanitizeRepoRelativePath(input.remotePath)
    : "";
  const manifestFiles: HfManifestFile[] = [];
  const destinations = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    state.currentFile = file.relative;
    let candidates = directory
      ? remote.files.filter(
          (entry) =>
            entry.path ===
            (remotePath ? `${remotePath}/${file.relative}` : file.relative),
        )
      : remote.files.filter(
          (entry) =>
            entry.size === file.size &&
            entry.path.toLowerCase().endsWith(".gguf"),
        );
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
        hash = await hashHfContentFile(file.path, file.size, lfs, signal);
        hashes.set(lfs, hash);
      }
      if (hash === (candidate.lfs?.oid ?? candidate.oid))
        matches.push(candidate);
    }
    if ((await importFileIdentity(file.path)) !== file.identity)
      throw new HfDownloadRequestError(
        `File changed during verification: ${file.path}`,
      );
    if (matches.length > 1)
      throw new HfDownloadRequestError(
        `Multiple matching repository files for ${file.relative}; specify the repository file path`,
      );
    const matched = matches[0];
    if (
      !matched &&
      (!directory ||
        candidates.length > 0 ||
        /\.(gguf|safetensors)$/i.test(file.path))
    )
      throw new HfDownloadRequestError(
        `No matching content in the repository: ${file.relative}`,
      );
    const destination =
      matched?.path ??
      (remotePath ? `${remotePath}/${file.relative}` : file.relative);
    sanitizeRepoRelativePath(destination);
    if (destinations.has(destination))
      throw new HfDownloadRequestError(
        `Multiple source files map to ${destination}`,
      );
    destinations.add(destination);
    if (matched)
      manifestFiles.push({
        path: matched.path,
        size: matched.size,
        oid: matched.oid,
        lfsOid: matched.lfs?.oid ?? null,
        lastCommitId: null,
        lastCommitDate: null,
      });
    state.files.push({
      source: file.path,
      destination: resolveWithin(destDir, destination),
      size: file.size,
      verified: Boolean(matched),
    });
    state.completed++;
  }
  for (const file of manifestFiles) {
    const split = parseSplitInfo(basename(file.path));
    if (!split) continue;
    for (let index = 1; index <= split.count; index++) {
      const shard = join(
        dirname(file.path),
        splitShardName(split, index, split.count),
      );
      if (!destinations.has(shard))
        throw new HfDownloadRequestError(`Missing GGUF shard: ${shard}`);
    }
  }
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
      if (!files.some((entry) => entry.relative === shard))
        throw new HfDownloadRequestError(`Missing safetensors shard: ${shard}`);
    }
  }
  for (const file of files.filter((entry) =>
    entry.relative.endsWith(".safetensors.index.json"),
  )) {
    const index: unknown = JSON.parse(await readFile(file.path, "utf8"));
    if (
      !index ||
      typeof index !== "object" ||
      !("weight_map" in index) ||
      !index.weight_map ||
      typeof index.weight_map !== "object"
    )
      throw new HfDownloadRequestError(
        `Invalid safetensors index: ${file.relative}`,
      );
    for (const shard of Object.values(index.weight_map)) {
      if (
        typeof shard !== "string" ||
        !files.some(
          (entry) =>
            entry.path ===
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
  return { source, directory, files, manifestFiles, state };
}
