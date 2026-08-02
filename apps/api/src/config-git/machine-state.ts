import { EnvironmentSpecSchema, PathCatalogEntrySchema } from "@arriero/core";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { isExactGitRepository, runGit, tryGit } from "../git/process.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

export const MACHINE_STATE_FILE_SCHEMAS: Record<string, z.ZodType> = {
  "path-catalog.json": z.array(PathCatalogEntrySchema),
  "envs.json": z.array(EnvironmentSpecSchema),
};

export const MACHINE_STATE_CONFIG_FILES = Object.keys(
  MACHINE_STATE_FILE_SCHEMAS,
);

export const CONFIG_GITIGNORE_ENTRIES = [
  ".secrets.json",
  "*.tmp",
  ...MACHINE_STATE_CONFIG_FILES,
];

export const CONFIG_GITIGNORE_CONTENT = `${CONFIG_GITIGNORE_ENTRIES.join("\n")}\n`;

function appendMissingLines(path: string, entries: string[]): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (missing.length > 0) {
    appendFileSync(
      path,
      `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }
}

export async function ensureLocalExclude(repository: string): Promise<void> {
  const gitPath = await tryGit(repository, [
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

export async function restoreMachineStateFiles(
  root: string,
  snapshot: Map<string, string>,
): Promise<void> {
  if (snapshot.size === 0) return;
  const tracked = new Set(
    ((await tryGit(root, ["ls-files", "--", ...snapshot.keys()])) ?? "")
      .split("\n")
      .filter(Boolean),
  );
  for (const [name, content] of snapshot) {
    if (tracked.has(name)) continue;
    const path = resolve(root, name);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    atomicWriteFile(path, content);
  }
}

export async function withMachineStatePreserved<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const snapshot = snapshotMachineStateFiles(root);
  const result = await work();
  await restoreMachineStateFiles(root, snapshot);
  return result;
}

export async function untrackMachineStateFiles(): Promise<string[]> {
  appendMissingLines(config.configGitignoreFile, CONFIG_GITIGNORE_ENTRIES);
  if (!(await isExactGitRepository(config.configDir))) {
    return [];
  }
  await ensureLocalExclude(config.configDir);
  const tracked = await tryGit(config.configDir, [
    "ls-files",
    "--",
    ...MACHINE_STATE_CONFIG_FILES,
  ]);
  if (!tracked) {
    return [];
  }
  const files = tracked.split("\n").filter(Boolean);
  await runGit(config.configDir, [
    "rm",
    "--cached",
    "--ignore-unmatch",
    "--",
    ...MACHINE_STATE_CONFIG_FILES,
  ]);
  return files;
}
