import type { ModelScanRoot } from "@arriero/core";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { listPathCatalogEntries } from "../path-catalog/repository.js";
import { getModelScanSettings } from "./cache-repository.js";

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function llamaCppCacheDirectory() {
  const fromEnv = process.env.LLAMA_CACHE;
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome) {
    return join(resolve(xdgCacheHome), "llama.cpp");
  }
  return join(homedir(), ".cache", "llama.cpp");
}

export function listModelScanRoots(): ModelScanRoot[] {
  const roots: ModelScanRoot[] = [];
  const seen = new Set<string>();
  const push = (
    root: Omit<ModelScanRoot, "exists" | "path"> & {
      path: string;
    },
  ) => {
    const path = resolve(root.path);
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    roots.push({ ...root, path, exists: isDirectory(path) });
  };

  push({
    path: getModelScanSettings().directory,
    label: "Models directory",
    source: "settings",
    refId: null,
  });
  for (const entry of listPathCatalogEntries("models-dir")) {
    push({
      path: entry.path,
      label: entry.name,
      source: "catalog",
      refId: entry.id,
    });
  }
  const cacheDirectory = llamaCppCacheDirectory();
  if (isDirectory(cacheDirectory)) {
    push({
      path: cacheDirectory,
      label: "llama.cpp download cache",
      source: "llama-cache",
      refId: null,
    });
  }
  return roots;
}
