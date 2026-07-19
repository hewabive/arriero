import {
  ConfigGitCommitSchema,
  ConfigGitDiffSchema,
  ConfigGitStatusSchema,
  type ConfigGitBranch,
  type ConfigGitCommit,
  type ConfigGitDiff,
  type ConfigGitFileStatus,
  type ConfigGitStatus,
} from "@llama-manager/core";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { gitOutput, redactGitOutput, runGit, tryGit } from "./process.js";
import { getActiveConfigGitOperation } from "./state.js";

const DIFF_LIMIT = 512 * 1024;

async function isGitRepository(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const result = await runGit(path, ["rev-parse", "--show-toplevel"]);
    return realpathSync(result.stdout.trim()) === realpathSync(resolve(path));
  } catch {
    return false;
  }
}

function parseFileStatuses(output: string): ConfigGitFileStatus[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      index: line[0] ?? " ",
      worktree: line[1] ?? " ",
      path: line.slice(3),
    }));
}

async function aheadBehind(
  path: string,
  left: string,
  right: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const output = await tryGit(path, [
    "rev-list",
    "--left-right",
    "--count",
    `${left}...${right}`,
  ]);
  if (!output) return { ahead: null, behind: null };
  const [aheadRaw, behindRaw] = output.split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

async function listBranches(
  path: string,
  currentBranch: string | null,
): Promise<ConfigGitBranch[]> {
  const names =
    (
      await tryGit(path, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
    )
      ?.split("\n")
      .filter(Boolean) ?? [];
  return Promise.all(
    names.map(async (name) => {
      const upstream = await tryGit(path, [
        "for-each-ref",
        "--format=%(upstream:short)",
        `refs/heads/${name}`,
      ]);
      const counts = upstream
        ? await aheadBehind(path, name, upstream)
        : { ahead: null, behind: null };
      return {
        name,
        current: name === currentBranch,
        upstream,
        ...counts,
      };
    }),
  );
}

async function remoteBranches(path: string): Promise<string[]> {
  const output = await tryGit(path, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]);
  return (output?.split("\n") ?? [])
    .filter(Boolean)
    .filter((name) => name !== "origin" && name !== "origin/HEAD")
    .map((name) => name.replace(/^origin\//, ""));
}

function emptyStatus(error: string | null): ConfigGitStatus {
  return ConfigGitStatusSchema.parse({
    configDir: config.configDir,
    exists: existsSync(config.configDir),
    isGitRepo: false,
    originUrl: null,
    branch: null,
    detached: false,
    head: null,
    shortHead: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: false,
    files: [],
    branches: [],
    remoteBranches: [],
    authorName: null,
    authorEmail: null,
    activeOperation: getActiveConfigGitOperation(),
    error,
  });
}

export async function getConfigGitStatus(): Promise<ConfigGitStatus> {
  const path = config.configDir;
  if (!(await isGitRepository(path))) return emptyStatus(null);
  try {
    const [
      head,
      shortHead,
      branchRaw,
      originRaw,
      statusResult,
      authorName,
      authorEmail,
    ] = await Promise.all([
      tryGit(path, ["rev-parse", "HEAD"]),
      tryGit(path, ["rev-parse", "--short", "HEAD"]),
      tryGit(path, ["branch", "--show-current"]),
      tryGit(path, ["remote", "get-url", "origin"]),
      runGit(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
      tryGit(path, ["config", "--get", "user.name"]),
      tryGit(path, ["config", "--get", "user.email"]),
    ]);
    const branch = branchRaw || null;
    const upstream = branch
      ? await tryGit(path, ["rev-parse", "--abbrev-ref", "@{u}"])
      : null;
    const counts = upstream
      ? await aheadBehind(path, "HEAD", upstream)
      : { ahead: null, behind: null };
    const files = parseFileStatuses(statusResult.stdout.trim());
    const [branches, remotes] = await Promise.all([
      listBranches(path, branch),
      remoteBranches(path),
    ]);
    return ConfigGitStatusSchema.parse({
      configDir: path,
      exists: true,
      isGitRepo: true,
      originUrl: originRaw ? redactGitOutput(originRaw) : null,
      branch,
      detached: branch === null,
      head,
      shortHead,
      upstream,
      ...counts,
      dirty: files.length > 0,
      files,
      branches,
      remoteBranches: remotes,
      authorName,
      authorEmail,
      activeOperation: getActiveConfigGitOperation(),
      error: null,
    });
  } catch (error) {
    return emptyStatus((error as Error).message);
  }
}

function limitDiff(value: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= DIFF_LIMIT) {
    return { text: value, truncated: false };
  }
  return {
    text: `${Buffer.from(value).subarray(0, DIFF_LIMIT).toString("utf8")}\n\n[diff truncated]`,
    truncated: true,
  };
}

export async function getConfigGitDiff(): Promise<ConfigGitDiff> {
  if (!(await isGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const [stagedResult, unstagedResult] = await Promise.all([
    runGit(config.configDir, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
    ]),
    runGit(config.configDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
    ]),
  ]);
  const staged = limitDiff(stagedResult.stdout);
  const unstaged = limitDiff(unstagedResult.stdout);
  return ConfigGitDiffSchema.parse({
    staged: staged.text,
    unstaged: unstaged.text,
    truncated: staged.truncated || unstaged.truncated,
  });
}

function parseCommits(output: string): ConfigGitCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        body,
      ] = record.split("\x1f");
      return ConfigGitCommitSchema.parse({
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        body: body ?? "",
      });
    });
}

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";

export async function getConfigGitLog(limit = 50): Promise<ConfigGitCommit[]> {
  if (!(await isGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const result = await runGit(config.configDir, [
    "log",
    `--max-count=${safeLimit}`,
    `--format=${LOG_FORMAT}`,
  ]);
  return parseCommits(result.stdout);
}

export async function getConfigGitCommit(
  commit: string,
): Promise<ConfigGitCommit> {
  if (!(await isGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const verified = await runGit(config.configDir, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ]);
  const result = await runGit(config.configDir, [
    "show",
    "--no-patch",
    `--format=${LOG_FORMAT}`,
    verified.stdout.trim(),
  ]);
  const parsed = parseCommits(result.stdout)[0];
  if (!parsed) throw new Error(`commit not found: ${commit}`);
  return parsed;
}

export async function assertConfigGitRepository(): Promise<void> {
  if (!(await isGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
}

export function commandOutput(
  result: Awaited<ReturnType<typeof runGit>>,
): string {
  return gitOutput(result);
}
