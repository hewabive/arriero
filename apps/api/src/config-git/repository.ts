import {
  ConfigGitCommitDetailSchema,
  ConfigGitCommitSchema,
  ConfigGitDiffSchema,
  ConfigGitStatusSchema,
  type ConfigGitBranch,
  type ConfigGitCommit,
  type ConfigGitCommitDetail,
  type ConfigGitCommitFileChange,
  type ConfigGitDiff,
  type ConfigGitFileStatus,
  type ConfigGitStatus,
} from "@arriero/core";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { config } from "../config.js";
import { assertSafeConfigRelativePath } from "./paths.js";
import {
  gitOutput,
  isExactGitRepository,
  redactGitOutput,
  runGit,
  tryGit,
} from "./process.js";
import { getActiveConfigGitOperation } from "./state.js";

const DIFF_LIMIT = 512 * 1024;

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

export function listConfigBackups(): string[] {
  const parent = dirname(config.configDir);
  const prefix = `${basename(config.configDir)}.backup-`;
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => resolve(parent, entry.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function hasUnpushedCommits(
  branches: ConfigGitBranch[],
  hasCommits: boolean,
): boolean {
  if (!hasCommits) return false;
  return branches.some((branch) =>
    branch.upstream ? (branch.ahead ?? 0) > 0 : true,
  );
}

function emptyStatus(error: string | null): ConfigGitStatus {
  return ConfigGitStatusSchema.parse({
    configDir: config.configDir,
    exists: existsSync(config.configDir),
    isGitRepo: false,
    originUrl: null,
    originRedacted: false,
    branch: null,
    detached: false,
    head: null,
    shortHead: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: false,
    hasCommits: false,
    hasUnpushedCommits: false,
    files: [],
    branches: [],
    remoteBranches: [],
    backups: listConfigBackups(),
    authorName: null,
    authorEmail: null,
    activeOperation: getActiveConfigGitOperation(),
    error,
  });
}

export async function getConfigGitStatus(): Promise<ConfigGitStatus> {
  const path = config.configDir;
  if (!(await isExactGitRepository(path))) return emptyStatus(null);
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
    const originUrl = originRaw ? redactGitOutput(originRaw) : null;
    return ConfigGitStatusSchema.parse({
      configDir: path,
      exists: true,
      isGitRepo: true,
      originUrl,
      originRedacted: originUrl !== originRaw,
      branch,
      detached: branch === null,
      head,
      shortHead,
      upstream,
      ...counts,
      dirty: files.length > 0,
      hasCommits: head !== null,
      hasUnpushedCommits: hasUnpushedCommits(branches, head !== null),
      files,
      branches,
      remoteBranches: remotes,
      backups: listConfigBackups(),
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

export async function getConfigGitDiff(path?: string): Promise<ConfigGitDiff> {
  if (!(await isExactGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const pathspec = path ? ["--", assertSafeConfigRelativePath(path)] : [];
  const [stagedResult, unstagedResult] = await Promise.all([
    runGit(config.configDir, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      ...pathspec,
    ]),
    runGit(config.configDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      ...pathspec,
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
  if (!(await isExactGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const head = await tryGit(config.configDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  if (!head) return [];
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const result = await runGit(config.configDir, [
    "log",
    `--max-count=${safeLimit}`,
    `--format=${LOG_FORMAT}`,
  ]);
  return parseCommits(result.stdout);
}

function parseNameStatus(output: string): ConfigGitCommitFileChange[] {
  const parts = output.split("\0").filter(Boolean);
  const files: ConfigGitCommitFileChange[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index];
    const path = parts[index + 1];
    if (status && path) {
      files.push({ path, status: status.slice(0, 1) });
    }
  }
  return files;
}

export async function resolveConfigGitCommit(ref: string): Promise<string> {
  if (ref.startsWith("-")) {
    throw new Error(`unknown ref: ${ref}`);
  }
  const verified = await runGit(config.configDir, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  return verified.stdout.trim();
}

export async function getConfigGitCommit(
  commit: string,
): Promise<ConfigGitCommitDetail> {
  if (!(await isExactGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const hash = await resolveConfigGitCommit(commit);
  const [result, changed, tree] = await Promise.all([
    runGit(config.configDir, [
      "show",
      "--no-patch",
      `--format=${LOG_FORMAT}`,
      hash,
    ]),
    runGit(config.configDir, [
      "show",
      "--format=",
      "--name-status",
      "--no-renames",
      "-z",
      hash,
    ]),
    runGit(config.configDir, ["ls-tree", "-r", "--name-only", "-z", hash]),
  ]);
  const parsed = parseCommits(result.stdout)[0];
  if (!parsed) throw new Error(`commit not found: ${commit}`);
  return ConfigGitCommitDetailSchema.parse({
    ...parsed,
    files: parseNameStatus(changed.stdout),
    tree: tree.stdout.split("\0").filter(Boolean),
  });
}

export async function assertConfigGitRepository(): Promise<void> {
  if (!(await isExactGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
}

export function commandOutput(
  result: Awaited<ReturnType<typeof runGit>>,
): string {
  return gitOutput(result);
}
