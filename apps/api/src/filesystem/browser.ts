import type {
  FileSystemEntry,
  FileSystemListResult,
  FileSystemRoot,
} from "@arriero/core";
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, parse, resolve } from "node:path";

import { config } from "../config.js";

function nowIsoFromMs(value: number) {
  return new Date(value).toISOString();
}

function uniqueRoots(roots: FileSystemRoot[]) {
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root.path)) {
      return false;
    }
    seen.add(root.path);
    return true;
  });
}

function rootEntries(currentPath: string): FileSystemRoot[] {
  return uniqueRoots([
    { label: "Home", path: homedir() },
    { label: "Manager", path: config.rootDir },
    { label: "Current", path: process.cwd() },
    {
      label: basename(parse(currentPath).root) || parse(currentPath).root,
      path: parse(currentPath).root,
    },
  ]);
}

function hasAccess(path: string, mode: number) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function entryType(path: string) {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) return "directory";
      if (stat.isFile()) return "file";
      return "other";
    } catch {
      return "other";
    }
  }
}

function fileEntry(path: string, name: string): FileSystemEntry {
  let sizeBytes: number | null = null;
  let modifiedAt: string | null = null;
  let executable = false;
  let readable = false;

  try {
    const stat = statSync(path);
    sizeBytes = stat.isFile() ? stat.size : null;
    modifiedAt = nowIsoFromMs(stat.mtimeMs);
    executable =
      process.platform === "win32" ||
      (!stat.isDirectory() && hasAccess(path, constants.X_OK));
    readable = hasAccess(path, constants.R_OK);
  } catch {
    readable = false;
  }

  return {
    name,
    path,
    type: entryType(path),
    extension: extname(name).toLowerCase() || null,
    sizeBytes,
    modifiedAt,
    executable,
    readable,
  };
}

function sortEntries(left: FileSystemEntry, right: FileSystemEntry) {
  if (left.type === "directory" && right.type !== "directory") return -1;
  if (left.type !== "directory" && right.type === "directory") return 1;
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function normalizeDirectory(inputPath?: string) {
  const fallback = homedir();
  return resolve(inputPath?.trim() || fallback);
}

export function listFilesystemDirectory(
  inputPath?: string,
): FileSystemListResult {
  const currentPath = normalizeDirectory(inputPath);
  const stat = statSync(currentPath);
  if (!stat.isDirectory()) {
    throw new Error(`${currentPath} is not a directory`);
  }

  const entries = readdirSync(currentPath, { withFileTypes: true })
    .map((entry) => fileEntry(resolve(currentPath, entry.name), entry.name))
    .sort(sortEntries);
  const parentPath = dirname(currentPath);

  return {
    path: currentPath,
    parentPath: parentPath === currentPath ? null : parentPath,
    roots: rootEntries(currentPath),
    entries,
  };
}
