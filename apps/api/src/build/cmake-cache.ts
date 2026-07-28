import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_FILE_NAME = "CMakeCache.txt";
const CACHED_BUILD_DIR_KEY = "CMAKE_CACHEFILE_DIR";
const CACHED_SOURCE_DIR_KEY = "CMAKE_HOME_DIRECTORY";

export function readCmakeCacheEntry(contents: string, key: string) {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) {
      continue;
    }
    const rest = trimmed.slice(key.length);
    if (!rest.startsWith("=") && !rest.startsWith(":")) {
      continue;
    }
    const separator = rest.indexOf("=");
    if (separator === -1) {
      continue;
    }
    return rest.slice(separator + 1).trim();
  }
  return null;
}

function canonicalPath(path: string) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function samePath(left: string, right: string) {
  return canonicalPath(left) === canonicalPath(right);
}

export function describeRelocatedCmakeCache(
  contents: string,
  expected: { buildDir: string; sourceDir: string },
): string | null {
  const relocations: string[] = [];

  const cachedBuildDir = readCmakeCacheEntry(contents, CACHED_BUILD_DIR_KEY);
  if (cachedBuildDir && !samePath(cachedBuildDir, expected.buildDir)) {
    relocations.push(`build directory ${cachedBuildDir}`);
  }

  const cachedSourceDir = readCmakeCacheEntry(contents, CACHED_SOURCE_DIR_KEY);
  if (cachedSourceDir && !samePath(cachedSourceDir, expected.sourceDir)) {
    relocations.push(`source directory ${cachedSourceDir}`);
  }

  if (relocations.length === 0) {
    return null;
  }

  return `${CACHE_FILE_NAME} in ${resolve(expected.buildDir)} was generated for ${relocations.join(" and ")}`;
}

export function relocatedCmakeCacheReason(
  buildDir: string,
  sourceDir: string,
): string | null {
  const cachePath = resolve(buildDir, CACHE_FILE_NAME);
  if (!existsSync(cachePath)) {
    return null;
  }

  let contents: string;
  try {
    contents = readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }

  return describeRelocatedCmakeCache(contents, { buildDir, sourceDir });
}
