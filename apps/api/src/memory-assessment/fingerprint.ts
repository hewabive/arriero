import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJsonDigest as digest } from "../utils/canonical-json.js";
import { sortedByKey } from "../utils/sort.js";
import type { FileIdentity, MemoryAssessmentFingerprint } from "./receipt.js";

const DIRECTORY_FILE_LIMIT = 256;
const DIRECTORY_WALK_DEPTH = 3;
const FINGERPRINT_CACHE_TTL_MS = 10_000;
const FINGERPRINT_CACHE_LIMIT = 128;

const fingerprintCache = new Map<
  string,
  { fingerprint: MemoryAssessmentFingerprint; expiresAt: number }
>();

export function normalizedPath(path: string): string {
  if (!path) return "";
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function fileIdentity(path: string): FileIdentity | null {
  try {
    if (!path || !existsSync(path)) return null;
    const normalized = normalizedPath(path);
    const stat = statSync(normalized);
    if (!stat.isFile()) return null;
    return {
      path: normalized,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function collectDirectoryFiles(
  directory: string,
  depth: number,
  bucket: FileIdentity[],
) {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const path = resolve(directory, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      bucket.push({
        path,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
    } else if (stat.isDirectory() && depth > 1) {
      collectDirectoryFiles(path, depth - 1, bucket);
    }
  }
}

function directoryArtifactIdentities(path: string): FileIdentity[] {
  const normalized = normalizedPath(path);
  const files: FileIdentity[] = [];
  collectDirectoryFiles(normalized, DIRECTORY_WALK_DEPTH, files);
  if (files.length === 0) {
    return [];
  }
  if (files.length <= DIRECTORY_FILE_LIMIT) {
    return sortedByKey(files, (file) => file.path);
  }
  return [
    {
      path: normalized,
      size: files.reduce((sum, file) => sum + file.size, 0),
      mtimeMs: files.reduce((max, file) => Math.max(max, file.mtimeMs), 0),
      fileCount: files.length,
    },
  ];
}

export function artifactIdentities(path: string): FileIdentity[] {
  const single = fileIdentity(path);
  if (single) return [single];
  try {
    if (path && statSync(normalizedPath(path)).isDirectory()) {
      return directoryArtifactIdentities(path);
    }
  } catch {
    return [];
  }
  return [];
}

export function cachedFingerprint(
  cacheKey: string,
  build: () => Omit<MemoryAssessmentFingerprint, "digest">,
): MemoryAssessmentFingerprint {
  const cached = fingerprintCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.fingerprint;
  }
  const base = build();
  const fingerprint = { ...base, digest: digest(base) };
  fingerprintCache.set(cacheKey, {
    fingerprint,
    expiresAt: Date.now() + FINGERPRINT_CACHE_TTL_MS,
  });
  while (fingerprintCache.size > FINGERPRINT_CACHE_LIMIT) {
    const oldest = fingerprintCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    fingerprintCache.delete(oldest);
  }
  return fingerprint;
}
