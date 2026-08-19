import type { BuildSettings } from "@arriero/core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { runGit } from "../git/process.js";
import { logger } from "../logger.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { uiDirectory } from "./plan.js";

export const UI_BUILD_STATE_FILE = resolve(
  config.dataDir,
  "ui-build-state.json",
);

const UiBuildStateSchema = z.record(z.string(), z.string());

export type UiTreeState = { treeHash: string | null; clean: boolean };

export type UiInstallEvaluation =
  | { skip: true; treeHash: string }
  | { skip: false; runReason: string; state: UiTreeState };

let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) {
    return cache;
  }
  const map = new Map<string, string>();
  if (existsSync(UI_BUILD_STATE_FILE)) {
    try {
      const parsed = UiBuildStateSchema.safeParse(
        JSON.parse(readFileSync(UI_BUILD_STATE_FILE, "utf8")),
      );
      if (parsed.success) {
        for (const [repoPath, treeHash] of Object.entries(parsed.data)) {
          map.set(repoPath, treeHash);
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, file: UI_BUILD_STATE_FILE },
        "failed to read UI build state; UI rebuild skip disabled until the next successful build",
      );
    }
  }
  cache = map;
  return map;
}

export function storedUiTreeHash(repoPath: string): string | null {
  return load().get(resolve(repoPath)) ?? null;
}

export function recordUiTreeHash(repoPath: string, treeHash: string): void {
  const map = load();
  map.set(resolve(repoPath), treeHash);
  atomicWriteFile(
    UI_BUILD_STATE_FILE,
    `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`,
  );
}

export function resetUiBuildStateCacheForTests(): void {
  cache = null;
}

export async function readUiTreeState(repoPath: string): Promise<UiTreeState> {
  let treeHash: string | null = null;
  try {
    const result = await runGit(repoPath, ["rev-parse", "HEAD:tools/ui"]);
    treeHash = result.stdout.trim() || null;
  } catch {
    return { treeHash: null, clean: false };
  }
  try {
    const status = await runGit(repoPath, [
      "status",
      "--porcelain",
      "--",
      "tools/ui",
    ]);
    return { treeHash, clean: status.stdout.trim() === "" };
  } catch {
    return { treeHash, clean: false };
  }
}

function uiDistExists(settings: BuildSettings): boolean {
  return existsSync(resolve(uiDirectory(settings), "dist", "index.html"));
}

export function uiInstallRunReason(
  state: UiTreeState,
  stored: string | null,
  distExists: boolean,
): string | null {
  if (!state.treeHash) {
    return "tools/ui tree hash is unavailable";
  }
  if (!state.clean) {
    return "tools/ui has local modifications";
  }
  if (!distExists) {
    return "tools/ui/dist is missing";
  }
  if (stored === null) {
    return "no recorded UI build for this checkout";
  }
  if (stored !== state.treeHash) {
    return "tools/ui changed since the last UI build";
  }
  return null;
}

export async function evaluateUiInstall(
  settings: BuildSettings,
): Promise<UiInstallEvaluation> {
  const state = await readUiTreeState(settings.repoPath);
  const runReason = uiInstallRunReason(
    state,
    storedUiTreeHash(settings.repoPath),
    uiDistExists(settings),
  );
  if (runReason !== null) {
    return { skip: false, runReason, state };
  }
  if (!state.treeHash) {
    return {
      skip: false,
      runReason: "tools/ui tree hash is unavailable",
      state,
    };
  }
  return { skip: true, treeHash: state.treeHash };
}
