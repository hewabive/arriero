import type {
  GgufMetadata,
  GgufModel,
  ModelScanResult,
  ModelScanRoot,
} from "@arriero/core";
import { opendir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  getCachedModel,
  listAllCachedModels,
  saveCachedModel,
} from "./cache-repository.js";
import { readGgufMetadata, readGgufParameterCount } from "./gguf.js";
import { parseSplitInfo, splitShardName, type SplitInfo } from "./split.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "runtime",
  "data",
  ".svelte-kit",
]);

const DEFAULT_MAX_DEPTH = 8;
const MAX_FILES = 2_000;

type FoundFile = {
  path: string;
  name: string;
  directory: string;
};

type ModelFile = FoundFile & {
  shardPaths: string[];
  missingShardNames: string[];
};

async function walk(
  dir: string,
  maxDepth: number,
  depth = 0,
  out: FoundFile[] = [],
) {
  if (out.length >= MAX_FILES) {
    return out;
  }

  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    if (depth === 0) {
      throw new Error(readDirectoryErrorMessage(dir, error));
    }
    return out;
  }

  for await (const entry of handle) {
    if (out.length >= MAX_FILES) {
      break;
    }

    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth && !IGNORED_DIRS.has(entry.name)) {
        await walk(entryPath, maxDepth, depth + 1, out);
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
      out.push({
        path: entryPath,
        name: entry.name,
        directory: dir,
      });
    }
  }

  return out;
}

function emptyMetadata(): GgufMetadata {
  return {
    name: null,
    architecture: null,
    modelType: null,
    poolingType: null,
    causalAttention: null,
    hasClassifierHead: false,
    quantization: null,
    quantizationVersion: null,
    sizeLabel: null,
    basename: null,
    finetune: null,
    license: null,
    licenseLink: null,
    repoUrl: null,
    version: null,
    quantizedBy: null,
    tags: [],
    baseModels: [],
    parameterCount: null,
    contextLength: null,
    embeddingLength: null,
    blockCount: null,
    leadingDenseBlockCount: null,
    feedForwardLength: null,
    expertCount: null,
    expertUsedCount: null,
    expertSharedCount: null,
    expertFeedForwardLength: null,
    headCount: null,
    headCountKv: null,
    attentionKeyLength: null,
    attentionValueLength: null,
    attentionKeyLengthMla: null,
    attentionValueLengthMla: null,
    slidingWindow: null,
    slidingWindowPattern: null,
    sharedKvLayers: null,
    ssmConvKernel: null,
    ssmGroupCount: null,
    ssmInnerSize: null,
    ssmStateSize: null,
    wkvHeadSize: null,
    tokenShiftCount: null,
    ropeFreqBase: null,
    ropeScalingType: null,
    ropeScalingFactor: null,
    ropeScalingOrigCtxLen: null,
    tokenizerModel: null,
    tokenizerPre: null,
    addBosToken: null,
    addEosToken: null,
    hasChatTemplate: false,
    vocabularySize: null,
    samplingTemp: null,
    samplingTopK: null,
    samplingTopP: null,
    imatrixDataset: null,
    imatrixEntries: null,
    imatrixChunks: null,
  };
}

function compareModelNames(
  left: { name: string; path: string },
  right: { name: string; path: string },
) {
  return (
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

function collapseSplitFiles(files: FoundFile[]): ModelFile[] {
  const splitGroups = new Map<
    string,
    { count: number; files: Array<FoundFile & { split: SplitInfo }> }
  >();
  const splitFilePaths = new Set<string>();

  for (const file of files) {
    const split = parseSplitInfo(file.name);
    if (!split) {
      continue;
    }

    const key = `${file.directory}\0${split.prefix}\0${split.count}`;
    const group = splitGroups.get(key) ?? { count: split.count, files: [] };
    group.files.push({ ...file, split });
    splitGroups.set(key, group);
    splitFilePaths.add(file.path);
  }

  const collapsed: ModelFile[] = files
    .filter((file) => !splitFilePaths.has(file.path))
    .map((file) => ({
      ...file,
      shardPaths: [file.path],
      missingShardNames: [],
    }));

  for (const group of splitGroups.values()) {
    const firstShard = group.files.find((file) => file.split.index === 1);
    if (!firstShard) {
      continue;
    }

    const presentIndexes = new Set(group.files.map((file) => file.split.index));
    const missingShardNames: string[] = [];
    for (let index = 1; index <= group.count; index += 1) {
      if (!presentIndexes.has(index)) {
        missingShardNames.push(
          splitShardName(firstShard.split, index, group.count),
        );
      }
    }

    collapsed.push({
      path: firstShard.path,
      name: firstShard.name,
      directory: firstShard.directory,
      shardPaths: group.files
        .sort((left, right) => left.split.index - right.split.index)
        .map((file) => file.path),
      missingShardNames,
    });
  }

  return collapsed.sort(compareModelNames);
}

function readDirectoryErrorMessage(directory: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return `Directory does not exist: ${directory}`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Permission denied while reading directory: ${directory}`;
  }
  return `Cannot read model directory ${directory}: ${(error as Error).message}`;
}

export async function scanModels(input: {
  roots: ModelScanRoot[];
  maxDepth?: number;
  refresh?: boolean;
}): Promise<ModelScanResult> {
  const maxDepth = Math.max(
    0,
    Math.min(input.maxDepth ?? DEFAULT_MAX_DEPTH, 16),
  );

  const found: FoundFile[] = [];
  const seenPaths = new Set<string>();
  for (const root of input.roots) {
    if (!root.exists) {
      continue;
    }
    for (const file of await walk(resolve(root.path), maxDepth)) {
      if (seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      found.push(file);
    }
  }

  const files = collapseSplitFiles(found);
  const mmprojByDir = new Map<string, string[]>();
  for (const file of files) {
    if (file.name.toLowerCase().includes("mmproj")) {
      const list = mmprojByDir.get(file.directory) ?? [];
      list.push(file.path);
      mmprojByDir.set(file.directory, list);
    }
  }

  const models: GgufModel[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const file of files) {
    const shardStats = await Promise.all(
      file.shardPaths.map((path) => stat(path)),
    );
    const sizeBytes = shardStats.reduce((sum, item) => sum + item.size, 0);
    const modifiedAt = new Date(
      Math.max(...shardStats.map((item) => item.mtime.getTime())),
    ).toISOString();
    const isMmproj = file.name.toLowerCase().includes("mmproj");
    const mmprojPaths = isMmproj ? [] : (mmprojByDir.get(file.directory) ?? []);
    const cached = input.refresh ? null : getCachedModel(file.path);
    if (
      cached &&
      cached.sizeBytes === sizeBytes &&
      cached.modifiedAt === modifiedAt
    ) {
      cacheHits += 1;
      models.push({
        ...cached,
        mmprojPaths,
      });
      continue;
    }

    cacheMisses += 1;
    let metadata = emptyMetadata();
    let error: string | undefined;

    try {
      metadata = readGgufMetadata(file.path);
      if (metadata.parameterCount !== null && file.shardPaths.length > 1) {
        try {
          let total = metadata.parameterCount;
          for (const shardPath of file.shardPaths.slice(1)) {
            total += readGgufParameterCount(shardPath);
          }
          metadata = { ...metadata, parameterCount: total };
        } catch {
          metadata = { ...metadata, parameterCount: null };
        }
      }
    } catch (caught) {
      error = (caught as Error).message;
    }
    if (file.missingShardNames.length > 0) {
      error = [
        error,
        `missing GGUF split shards: ${file.missingShardNames.join(", ")}`,
      ]
        .filter(Boolean)
        .join("; ");
    }

    const model: GgufModel = {
      name: basename(file.path),
      path: file.path,
      directory: dirname(file.path),
      sizeBytes,
      modifiedAt,
      isMmproj,
      mmprojPaths,
      metadata,
      ...(error ? { error } : {}),
    };
    saveCachedModel(model);
    models.push(model);
  }

  return {
    roots: input.roots,
    models: models.sort(compareModelNames),
    scannedAt: new Date().toISOString(),
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
    },
  };
}

function isUnderDirectory(path: string, directory: string, maxDepth: number) {
  const rel = relative(directory, dirname(path));
  if (rel.startsWith("..") || resolve(directory, rel) !== dirname(path)) {
    return false;
  }
  const depth = rel === "" ? 0 : rel.split(sep).length;
  return depth <= maxDepth;
}

export function scanModelsFromCache(input: {
  roots: ModelScanRoot[];
  maxDepth?: number;
}): ModelScanResult {
  const maxDepth = Math.max(
    0,
    Math.min(input.maxDepth ?? DEFAULT_MAX_DEPTH, 16),
  );
  const scoped = listAllCachedModels().filter((model) =>
    input.roots.some((root) =>
      isUnderDirectory(model.path, resolve(root.path), maxDepth),
    ),
  );

  const mmprojByDir = new Map<string, string[]>();
  for (const model of scoped) {
    if (model.isMmproj) {
      const list = mmprojByDir.get(model.directory) ?? [];
      list.push(model.path);
      mmprojByDir.set(model.directory, list);
    }
  }

  const models = scoped
    .map((model) => ({
      ...model,
      mmprojPaths: model.isMmproj
        ? []
        : (mmprojByDir.get(model.directory) ?? []),
    }))
    .sort(compareModelNames);

  return {
    roots: input.roots,
    models,
    scannedAt: "",
    cache: { hits: scoped.length, misses: 0 },
    fromCache: true,
  };
}
