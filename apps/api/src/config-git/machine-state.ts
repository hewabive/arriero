import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { config } from "../config.js";
import { runGitSync, tryGitSync } from "../git/process.js";

export const MACHINE_STATE_CONFIG_FILES = ["path-catalog.json", "envs.json"];

export const CONFIG_GITIGNORE_ENTRIES = [
  ".secrets.json",
  "*.tmp",
  ...MACHINE_STATE_CONFIG_FILES,
];

export const CONFIG_GITIGNORE_CONTENT = `${CONFIG_GITIGNORE_ENTRIES.join("\n")}\n`;

function appendMissingLines(path: string, entries: string[]): string[] {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (missing.length > 0) {
    appendFileSync(
      path,
      `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }
  return missing;
}

export function ensureLocalExclude(repository: string): void {
  const gitPath = tryGitSync(repository, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  if (!gitPath) return;
  const path = isAbsolute(gitPath) ? gitPath : resolve(repository, gitPath);
  mkdirSync(dirname(path), { recursive: true });
  appendMissingLines(path, CONFIG_GITIGNORE_ENTRIES);
}

export function snapshotMachineStateFiles(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const name of MACHINE_STATE_CONFIG_FILES) {
    const path = resolve(root, name);
    if (existsSync(path)) {
      snapshot.set(name, readFileSync(path, "utf8"));
    }
  }
  return snapshot;
}

export function restoreMachineStateFiles(
  root: string,
  snapshot: Map<string, string>,
): void {
  for (const [name, content] of snapshot) {
    if (tryGitSync(root, ["ls-files", "--", name])) {
      continue;
    }
    const path = resolve(root, name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  }
}

function isConfigRepository(root: string): boolean {
  if (!existsSync(root)) return false;
  const toplevel = tryGitSync(root, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return false;
  try {
    return realpathSync(toplevel) === realpathSync(root);
  } catch {
    return false;
  }
}

export function untrackMachineStateFiles(): string[] {
  appendMissingLines(config.configGitignoreFile, CONFIG_GITIGNORE_ENTRIES);
  if (!isConfigRepository(config.configDir)) {
    return [];
  }
  ensureLocalExclude(config.configDir);
  const tracked = tryGitSync(config.configDir, [
    "ls-files",
    "--",
    ...MACHINE_STATE_CONFIG_FILES,
  ]);
  if (!tracked) {
    return [];
  }
  const files = tracked.split("\n").filter(Boolean);
  runGitSync(config.configDir, [
    "rm",
    "--cached",
    "--ignore-unmatch",
    "--",
    ...MACHINE_STATE_CONFIG_FILES,
  ]);
  return files;
}
