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
import {
  isExactGitRepositorySync,
  repositoryHeadCommitSync,
  runGitSync,
  tryGitSync,
} from "../git/process.js";
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

export function listLlamaSourceRefs(): LlamaSourceRefs {
  const repoPath = getLlamaSourceSettings().repoPath;
  const empty = {
    branches: [],
    branchesWithUpstream: [],
    tags: [],
    currentBranch: null,
    dirty: null,
  };
  if (
    !isExactGitRepositorySync(repoPath) ||
    getSourceRepositoryDefinition(LLAMA_CPP_SOURCE_ID).validateCheckout(
      repoPath,
    ) !== null
  ) {
    return LlamaSourceRefsSchema.parse(empty);
  }

  try {
    const branches: string[] = [];
    const branchesWithUpstream: string[] = [];
    const branchLines = runGitSync(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)\t%(upstream)",
      "refs/heads",
    ])
      .split("\n")
      .filter(Boolean);
    for (const line of branchLines) {
      const [name, upstream] = line.split("\t");
      if (!name) continue;
      branches.push(name);
      if (upstream) branchesWithUpstream.push(name);
    }
    const tags = runGitSync(repoPath, [
      "for-each-ref",
      `--count=${RECENT_TAG_LIMIT}`,
      "--sort=-creatordate",
      "--format=%(refname:short)",
      "refs/tags",
    ])
      .split("\n")
      .filter(Boolean);
    return LlamaSourceRefsSchema.parse({
      branches,
      branchesWithUpstream,
      tags,
      currentBranch: tryGitSync(repoPath, ["branch", "--show-current"]),
      dirty: runGitSync(repoPath, ["status", "--porcelain"]).length > 0,
    });
  } catch {
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
      const refs = listLlamaSourceRefs();
      if (!refs.branches.includes(ref) && !refs.tags.includes(ref)) {
        throw new Error(`unknown git ref: ${ref}`);
      }
      if (refs.dirty === true) {
        throw new Error(
          `refusing to checkout ${ref}: the llama.cpp working tree has uncommitted changes — commit or stash them first`,
        );
      }
      runGitSync(status.repoPath, ["checkout", ref]);
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
