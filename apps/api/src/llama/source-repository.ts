import {
  LlamaSourceRefsSchema,
  LlamaSourceSettingsSchema,
  LlamaSourceSettingsUpdateSchema,
  LlamaSourceStatusSchema,
  type LlamaSourceRefs,
  type LlamaSourceSettings,
  type LlamaSourceSettingsUpdate,
  type LlamaSourceStatus,
} from "@arriero/core";
import { createHash } from "node:crypto";

import {
  isExactGitRepository,
  isExactGitRepositorySync,
  repositoryHeadCommitSync,
  runGit,
  runGitSync,
  tryGit,
  tryGitSync,
} from "../git/process.js";
import { logger } from "../logger.js";
import {
  getSourceRepositoryDefinition,
  LLAMA_CPP_SOURCE_ID,
} from "../sources/registry.js";
import {
  getSourceRepositorySpec,
  getSourceRepositoryStatus,
  saveSourceRepositoryPath,
  sourceRepositoryPath,
} from "../sources/repository.js";
import {
  getActiveSourceRepositoryOperation,
  withSourceRepositoryOperation,
} from "../sources/state.js";

export function getLlamaSourceSettings(): LlamaSourceSettings {
  const spec = getSourceRepositorySpec(LLAMA_CPP_SOURCE_ID);
  return LlamaSourceSettingsSchema.parse({
    repoPath: sourceRepositoryPath(spec),
  });
}

export function saveLlamaSourceSettings(
  input: LlamaSourceSettingsUpdate,
): LlamaSourceSettings {
  const settings = LlamaSourceSettingsUpdateSchema.parse(input);
  saveSourceRepositoryPath(LLAMA_CPP_SOURCE_ID, settings.repoPath);
  return getLlamaSourceSettings();
}

export function getLlamaSourceCurrentCommit(): string | null {
  return repositoryHeadCommitSync(getLlamaSourceSettings().repoPath);
}

const commitReachabilityCache = new Map<string, boolean>();

export function llamaSourceCommitIsReachable(
  commit: string,
  head: string | null = null,
): boolean | null {
  if (head !== null && commit === head) {
    return true;
  }
  const repoPath = getLlamaSourceSettings().repoPath;
  const cacheKey = head === null ? null : `${repoPath}|${commit}|${head}`;
  if (cacheKey !== null) {
    const cached = commitReachabilityCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }
  if (!isExactGitRepositorySync(repoPath)) {
    return null;
  }
  if (
    tryGitSync(repoPath, ["rev-parse", "--is-shallow-repository"]) !== "false"
  ) {
    return null;
  }
  let reachable: boolean;
  try {
    runGitSync(repoPath, [
      "merge-base",
      "--is-ancestor",
      commit,
      head ?? "HEAD",
    ]);
    reachable = true;
  } catch {
    reachable = false;
  }
  if (cacheKey !== null) {
    commitReachabilityCache.set(cacheKey, reachable);
  }
  return reachable;
}

export function getLlamaSourceVersionLabel(
  repoPath = getLlamaSourceSettings().repoPath,
): string | null {
  if (!isExactGitRepositorySync(repoPath)) {
    return null;
  }
  return (
    tryGitSync(repoPath, ["describe", "--tags", "--abbrev=0"]) ??
    tryGitSync(repoPath, ["rev-parse", "--short", "HEAD"])
  );
}

const RECENT_TAG_LIMIT = 100;

const recentTagsCache = new Map<
  string,
  { fingerprint: string; tags: string[] }
>();

async function listRecentTags(repoPath: string): Promise<string[]> {
  const refs = await runGit(repoPath, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/tags",
  ]);
  const fingerprint = createHash("sha256").update(refs.stdout).digest("hex");
  const cached = recentTagsCache.get(repoPath);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.tags;
  }
  const sorted = await runGit(repoPath, [
    "for-each-ref",
    `--count=${RECENT_TAG_LIMIT}`,
    "--sort=-creatordate",
    "--format=%(refname:short)",
    "refs/tags",
  ]);
  const tags = sorted.stdout.split("\n").filter(Boolean);
  recentTagsCache.set(repoPath, { fingerprint, tags });
  return tags;
}

export async function listLlamaSourceRefs(): Promise<LlamaSourceRefs> {
  const repoPath = getLlamaSourceSettings().repoPath;
  const empty = {
    branches: [],
    branchesWithUpstream: [],
    tags: [],
    currentBranch: null,
    dirty: null,
  };
  if (
    !(await isExactGitRepository(repoPath)) ||
    getSourceRepositoryDefinition(LLAMA_CPP_SOURCE_ID).validateCheckout(
      repoPath,
    ) !== null
  ) {
    return LlamaSourceRefsSchema.parse(empty);
  }

  try {
    const [headsResult, tags, currentBranch, statusResult] = await Promise.all([
      runGit(repoPath, [
        "for-each-ref",
        "--format=%(refname:short)\t%(upstream)",
        "refs/heads",
      ]),
      listRecentTags(repoPath),
      tryGit(repoPath, ["branch", "--show-current"]),
      runGit(repoPath, ["status", "--porcelain"]),
    ]);
    const branches: string[] = [];
    const branchesWithUpstream: string[] = [];
    for (const line of headsResult.stdout.split("\n").filter(Boolean)) {
      const [name, upstream] = line.split("\t");
      if (!name) continue;
      branches.push(name);
      if (upstream) branchesWithUpstream.push(name);
    }
    return LlamaSourceRefsSchema.parse({
      branches,
      branchesWithUpstream,
      tags,
      currentBranch,
      dirty: statusResult.stdout.trim().length > 0,
    });
  } catch (error) {
    logger.warn({ err: error, repoPath }, "failed to list llama source refs");
    return LlamaSourceRefsSchema.parse(empty);
  }
}

export async function checkoutLlamaSourceRef(
  ref: string,
): Promise<LlamaSourceStatus> {
  if (getActiveSourceRepositoryOperation(LLAMA_CPP_SOURCE_ID)) {
    throw new Error("cannot checkout while a source operation is running");
  }
  await withSourceRepositoryOperation(
    LLAMA_CPP_SOURCE_ID,
    "checkout",
    async () => {
      const status = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
      if (!status.valid) {
        throw new Error(
          status.error ?? `Repository path does not exist: ${status.repoPath}`,
        );
      }
      const refs = await listLlamaSourceRefs();
      if (!refs.branches.includes(ref) && !refs.tags.includes(ref)) {
        throw new Error(`unknown git ref: ${ref}`);
      }
      if (refs.dirty === true) {
        throw new Error(
          `refusing to checkout ${ref}: the llama.cpp working tree has uncommitted changes — commit or stash them first`,
        );
      }
      await runGit(status.repoPath, ["checkout", ref]);
    },
  );
  return getLlamaSourceStatus();
}

export async function getLlamaSourceStatus(): Promise<LlamaSourceStatus> {
  const status = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
  return LlamaSourceStatusSchema.parse({
    settings: {
      repoPath: status.repoPath,
    },
    exists: status.exists,
    isGitRepo: status.isGitRepo,
    currentCommit: status.currentCommit,
    latestTag: status.latestTag,
    branch: status.branch,
    remoteUrl: status.remoteUrl,
    dirty: status.dirty,
    checkedAt: status.checkedAt,
    error:
      status.state === "missing"
        ? `Repository path does not exist: ${status.repoPath}`
        : status.error,
  });
}
