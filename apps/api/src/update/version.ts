import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { AppVersionSchema, updateAdapter } from "./adapter.js";
import type { AppRunMode, AppVersion } from "./adapter.js";

const FETCH_TIMEOUT_MS = 20_000;

function nowIso() {
  return new Date().toISOString();
}

export function detectRunMode(argv1: string | undefined): AppRunMode {
  if (!argv1) {
    return "unknown";
  }
  if (argv1.endsWith(".ts")) {
    return "dev";
  }
  if (/[\\/]dist[\\/]index\.js$/.test(argv1)) {
    return "serve";
  }
  return "unknown";
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID);
}

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    cwd: updateAdapter.rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args: string[]): string | null {
  try {
    return runGit(args) || null;
  } catch {
    return null;
  }
}

function isGitRepo(): boolean {
  if (existsSync(resolve(updateAdapter.rootDir, ".git"))) {
    return true;
  }
  try {
    runGit(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

type UpdateCheck = {
  behindCount: number | null;
  upstreamCommit: string | null;
  lastCheckedAt: string;
};

let lastCheck: UpdateCheck | null = null;

function updateBlockedReason(mode: AppRunMode, repo: boolean): string | null {
  if (!repo) {
    return "not a git checkout; update from the UI is unavailable";
  }
  if (mode === "dev") {
    return "running in dev mode (tsx/vite hot-reload); update from the UI needs the serve deployment under systemd — use git pull manually";
  }
  if (mode === "unknown") {
    return "could not detect the run mode; update from the UI needs the serve deployment under systemd";
  }
  return null;
}

export function getAppVersion(): AppVersion {
  const repo = isGitRepo();
  const branchRaw = repo ? tryGit(["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  const dirtyText = repo ? tryGit(["status", "--porcelain"]) : null;
  const mode = detectRunMode(process.argv[1]);
  const blocked = updateBlockedReason(mode, repo);
  const behindCount = lastCheck?.behindCount ?? null;
  return AppVersionSchema.parse({
    commit: repo ? tryGit(["rev-parse", "HEAD"]) : null,
    shortCommit: repo ? tryGit(["rev-parse", "--short", "HEAD"]) : null,
    committedAt: repo ? tryGit(["log", "-1", "--format=%cI"]) : null,
    branch: branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    dirty: dirtyText !== null,
    isGitRepo: repo,
    mode,
    supervised: isSupervised(),
    canUpdate: blocked === null,
    updateBlockedReason: blocked,
    behindCount,
    upstreamCommit: lastCheck?.upstreamCommit ?? null,
    updateAvailable: behindCount !== null && behindCount > 0,
    lastCheckedAt: lastCheck?.lastCheckedAt ?? null,
  });
}

export function currentCommit(): string | null {
  return isGitRepo() ? tryGit(["rev-parse", "HEAD"]) : null;
}

function runGitFetch(): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const child = spawn("git", ["fetch", "--quiet"], {
      cwd: updateAdapter.rootDir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolveDone();
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(`git fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`),
      );
    }, FETCH_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (signal) {
        finish(new Error(`git fetch terminated by ${signal}`));
      } else if (code !== 0) {
        finish(
          new Error(stderr.trim() || `git fetch exited with code ${code}`),
        );
      } else {
        finish();
      }
    });
  });
}

export async function checkForUpdate(): Promise<{
  version: AppVersion;
  fetchError: string | null;
}> {
  let fetchError: string | null = null;
  if (isGitRepo()) {
    try {
      await runGitFetch();
    } catch (error) {
      fetchError = (error as Error).message;
    }
    const upstream = tryGit(["rev-parse", "@{u}"]);
    let behindCount: number | null = null;
    if (upstream) {
      const count = tryGit(["rev-list", "--count", "HEAD..@{u}"]);
      const parsed = count !== null ? Number(count) : Number.NaN;
      behindCount = Number.isFinite(parsed) ? parsed : null;
    }
    lastCheck = {
      behindCount,
      upstreamCommit: upstream,
      lastCheckedAt: nowIso(),
    };
  }
  return { version: getAppVersion(), fetchError };
}
