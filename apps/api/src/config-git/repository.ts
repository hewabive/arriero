import {
  ConfigGitCommitDetailSchema,
  ConfigGitCommitSchema,
  ConfigGitDiffSchema,
  ConfigGitStatusSchema,
  type ConfigGitBackups,
  type ConfigGitBranch,
  type ConfigGitCommit,
  type ConfigGitCommitDetail,
  type ConfigGitCommitFileChange,
  type ConfigGitDiff,
  type ConfigGitDirtySummary,
  type ConfigGitFileStatus,
  type ConfigGitStatus,
} from "@arriero/core";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { config } from "../config.js";
import { traceBlockingSection } from "../system/event-loop.js";
import { assertSafeConfigRelativePath } from "./paths.js";
import {
  isExactGitRepository,
  redactGitOutput,
  runGit,
  tryGit,
} from "./process.js";
import {
  getActiveConfigGitOperation,
  withConfigGitOperation,
} from "./state.js";

const DIFF_LIMIT = 512 * 1024;

const RENAME_STATUS_SEPARATOR = " -> ";

export function parseFileStatuses(output: string): ConfigGitFileStatus[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const index = line[0] ?? " ";
      const worktree = line[1] ?? " ";
      const raw = line.slice(3);
      const arrow =
        index === "R" || index === "C"
          ? raw.indexOf(RENAME_STATUS_SEPARATOR)
          : -1;
      if (arrow === -1) {
        return { index, worktree, path: raw, origPath: null };
      }
      return {
        index,
        worktree,
        path: raw.slice(arrow + RENAME_STATUS_SEPARATOR.length),
        origPath: raw.slice(0, arrow),
      };
    });
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

function listConfigBackups(): string[] {
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

export async function deleteConfigBackup(
  name: string,
): Promise<ConfigGitBackups> {
  return withConfigGitOperation(`delete backup ${name}`, async () => {
    const prefix = `${basename(config.configDir)}.backup-`;
    if (!name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) {
      throw new Error(`not a config backup name: ${name}`);
    }
    const path = resolve(dirname(config.configDir), name);
    if (!listConfigBackups().includes(path)) {
      throw new Error(`config backup not found: ${name}`);
    }
    traceBlockingSection("config-git:rm-backup", () =>
      rmSync(path, { recursive: true, force: true }),
    );
    return { backups: listConfigBackups() };
  });
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
    const files = parseFileStatuses(statusResult.stdout);
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

export async function getConfigGitDirtySummary(): Promise<ConfigGitDirtySummary> {
  const path = config.configDir;
  if (!(await isExactGitRepository(path))) {
    return { isGitRepo: false, dirty: false, fileCount: 0 };
  }
  const statusResult = await runGit(path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const fileCount = parseFileStatuses(statusResult.stdout).length;
  return { isGitRepo: true, dirty: fileCount > 0, fileCount };
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

const DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

async function listUntrackedFiles(pathspec: string[]): Promise<string[]> {
  const result = await runGit(config.configDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...pathspec,
  ]);
  return result.stdout.split("\0").filter(Boolean);
}

async function untrackedFileDiff(file: string): Promise<string> {
  const result = await runGit(
    config.configDir,
    ["diff", ...DIFF_ARGS, "--no-index", "--", "/dev/null", file],
    { allowExitCodes: [0, 1] },
  );
  return result.stdout;
}

const UNTRACKED_DIFF_BATCH = 8;

async function untrackedFileDiffs(files: string[]): Promise<string[]> {
  const diffs: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += UNTRACKED_DIFF_BATCH) {
    if (totalBytes > DIFF_LIMIT) break;
    const batch = await Promise.all(
      files.slice(index, index + UNTRACKED_DIFF_BATCH).map(untrackedFileDiff),
    );
    for (const diff of batch) {
      diffs.push(diff);
      totalBytes += Buffer.byteLength(diff, "utf8");
    }
  }
  return diffs;
}

export async function getConfigGitDiff(path?: string): Promise<ConfigGitDiff> {
  if (!(await isExactGitRepository(config.configDir))) {
    throw new Error("configuration directory is not a git repository");
  }
  const pathspec = path ? ["--", assertSafeConfigRelativePath(path)] : [];
  const [stagedResult, unstagedResult, untrackedFiles] = await Promise.all([
    runGit(config.configDir, ["diff", "--cached", ...DIFF_ARGS, ...pathspec]),
    runGit(config.configDir, ["diff", ...DIFF_ARGS, ...pathspec]),
    listUntrackedFiles(pathspec),
  ]);
  const untrackedDiffs = await untrackedFileDiffs(untrackedFiles);
  const staged = limitDiff(stagedResult.stdout);
  const unstaged = limitDiff(
    [unstagedResult.stdout, ...untrackedDiffs].filter(Boolean).join(""),
  );
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
