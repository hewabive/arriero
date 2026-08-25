import {
  SourceRepositorySpecSchema,
  SourceRepositoryStatusSchema,
  type SourceRepositorySpec,
  type SourceRepositoryStatus,
} from "@arriero/core";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { redactGitOutput, runGit, tryGit } from "../git/process.js";
import { readSettings, writeSettings } from "../settings/store.js";
import {
  getSourceRepositoryDefinition,
  LLAMA_CPP_SOURCE_ID,
  listSourceRepositoryDefinitions,
} from "./registry.js";
import { getActiveSourceRepositoryOperation } from "./state.js";

function nowIso() {
  return new Date().toISOString();
}

function managedPath(sourceId: string): string {
  const definition = getSourceRepositoryDefinition(sourceId);
  return resolve(config.sourcesDir, definition.directoryName);
}

function legacyDefaultLlamaSourcePath(): string {
  return resolve(config.rootDir, "..", "llama.cpp");
}

function inferredSpec(sourceId: string): SourceRepositorySpec {
  const definition = getSourceRepositoryDefinition(sourceId);
  const settings = readSettings();
  const legacy = sourceId === LLAMA_CPP_SOURCE_ID ? settings.llamaSource : null;
  let location: SourceRepositorySpec["location"] = { type: "managed" };

  if (legacy) {
    const legacyPath = resolve(legacy.repoPath);
    const obsoleteDefault = legacyDefaultLlamaSourcePath();
    location =
      legacyPath === managedPath(sourceId) ||
      (legacyPath === obsoleteDefault && !existsSync(legacyPath))
        ? { type: "managed" }
        : { type: "external", path: legacyPath };
  } else if (sourceId === LLAMA_CPP_SOURCE_ID) {
    const oldCheckout = legacyDefaultLlamaSourcePath();
    if (!existsSync(managedPath(sourceId)) && existsSync(oldCheckout)) {
      location = { type: "external", path: oldCheckout };
    }
  }

  return SourceRepositorySpecSchema.parse({
    id: sourceId,
    adapter: definition.adapter,
    originUrl: definition.defaultOriginUrl,
    location,
  });
}

export function getSourceRepositorySpec(
  sourceId: string,
): SourceRepositorySpec {
  const definition = getSourceRepositoryDefinition(sourceId);
  const stored = readSettings().sourceRepositories?.find(
    (item) => item.id === sourceId,
  );
  if (!stored) {
    return inferredSpec(sourceId);
  }
  if (stored.adapter !== definition.adapter) {
    throw new Error(
      `source repository ${sourceId} uses adapter ${stored.adapter}, expected ${definition.adapter}`,
    );
  }
  return SourceRepositorySpecSchema.parse({
    ...stored,
    location:
      stored.location.type === "external"
        ? { type: "external", path: resolve(stored.location.path) }
        : stored.location,
  });
}

export function sourceRepositoryPath(
  source: string | SourceRepositorySpec,
): string {
  const spec =
    typeof source === "string" ? getSourceRepositorySpec(source) : source;
  return spec.location.type === "managed"
    ? managedPath(spec.id)
    : resolve(spec.location.path);
}

function saveSourceRepositorySpec(
  input: SourceRepositorySpec,
): SourceRepositorySpec {
  const parsed = SourceRepositorySpecSchema.parse(input);
  const definition = getSourceRepositoryDefinition(parsed.id);
  if (parsed.adapter !== definition.adapter) {
    throw new Error(
      `source repository ${parsed.id} must use adapter ${definition.adapter}`,
    );
  }
  const normalized = SourceRepositorySpecSchema.parse({
    ...parsed,
    location:
      parsed.location.type === "external"
        ? { type: "external", path: resolve(parsed.location.path) }
        : parsed.location,
  });
  const current = readSettings();
  const existing = (current.sourceRepositories ?? []).find(
    (item) => item.id === normalized.id,
  );
  const repositories = [
    ...(current.sourceRepositories ?? []).filter(
      (item) => item.id !== normalized.id,
    ),
    { ...existing, ...normalized },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const next =
    normalized.id === LLAMA_CPP_SOURCE_ID
      ? (({ llamaSource: _legacy, ...rest }) => ({
          ...rest,
          sourceRepositories: repositories,
        }))(current)
      : { ...current, sourceRepositories: repositories };
  writeSettings(next);
  return getSourceRepositorySpec(normalized.id);
}

export function saveSourceRepositoryPath(
  sourceId: string,
  repoPath: string,
): SourceRepositorySpec {
  const activeOperation = getActiveSourceRepositoryOperation(sourceId);
  if (activeOperation) {
    throw new Error(
      `cannot change source repository path while ${activeOperation} is running`,
    );
  }
  const current = getSourceRepositorySpec(sourceId);
  const resolved = resolve(repoPath);
  return saveSourceRepositorySpec({
    ...current,
    location:
      resolved === managedPath(sourceId)
        ? { type: "managed" }
        : { type: "external", path: resolved },
  });
}

export function saveSourceRepositoryOrigin(
  sourceId: string,
  originUrl: string,
): SourceRepositorySpec {
  return saveSourceRepositorySpec({
    ...getSourceRepositorySpec(sourceId),
    originUrl,
  });
}

function emptyStatus(
  spec: SourceRepositorySpec,
  input: {
    state: SourceRepositoryStatus["state"];
    exists: boolean;
    activeOperation: string | null;
    error: string | null;
  },
): SourceRepositoryStatus {
  const definition = getSourceRepositoryDefinition(spec.id);
  return SourceRepositoryStatusSchema.parse({
    spec,
    displayName: definition.displayName,
    repoPath: sourceRepositoryPath(spec),
    state: input.state,
    exists: input.exists,
    isGitRepo: false,
    valid: false,
    currentCommit: null,
    latestTag: null,
    branch: null,
    remoteUrl: null,
    originMatches: null,
    dirty: null,
    tracking: definition.tracking,
    driftSupported: definition.driftSupported,
    activeOperation: input.activeOperation,
    checkedAt: nowIso(),
    error: input.error,
  });
}

async function gitValue(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).stdout.trim();
}

export async function getSourceRepositoryStatus(
  sourceId: string,
): Promise<SourceRepositoryStatus> {
  const spec = getSourceRepositorySpec(sourceId);
  const definition = getSourceRepositoryDefinition(sourceId);
  const repoPath = sourceRepositoryPath(spec);
  const activeOperation = getActiveSourceRepositoryOperation(sourceId);

  if (!existsSync(repoPath)) {
    return emptyStatus(spec, {
      state: activeOperation ? "busy" : "missing",
      exists: false,
      activeOperation,
      error: null,
    });
  }
  try {
    if (!statSync(repoPath).isDirectory()) {
      return emptyStatus(spec, {
        state: "invalid",
        exists: true,
        activeOperation,
        error: `Repository path is not a directory: ${repoPath}`,
      });
    }
  } catch (error) {
    return emptyStatus(spec, {
      state: "error",
      exists: true,
      activeOperation,
      error: (error as Error).message,
    });
  }

  let topLevel: string;
  try {
    topLevel = await gitValue(repoPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    return emptyStatus(spec, {
      state: "invalid",
      exists: true,
      activeOperation,
      error: `Not a Git repository at ${repoPath}: ${(error as Error).message}`,
    });
  }

  try {
    if (realpathSync(topLevel) !== realpathSync(repoPath)) {
      return emptyStatus(spec, {
        state: "invalid",
        exists: true,
        activeOperation,
        error: `Git repository root is ${topLevel}, not the configured source path ${repoPath}`,
      });
    }
  } catch (error) {
    return emptyStatus(spec, {
      state: "error",
      exists: true,
      activeOperation,
      error: (error as Error).message,
    });
  }

  const checkoutError = definition.validateCheckout(repoPath);
  if (checkoutError) {
    const invalid = emptyStatus(spec, {
      state: "invalid",
      exists: true,
      activeOperation,
      error: checkoutError,
    });
    return SourceRepositoryStatusSchema.parse({
      ...invalid,
      isGitRepo: true,
    });
  }

  try {
    const currentCommit = await gitValue(repoPath, ["rev-parse", "HEAD"]);
    const branch = await tryGit(repoPath, ["branch", "--show-current"]);
    const remoteRaw = await tryGit(repoPath, ["remote", "get-url", "origin"]);
    const remoteUrl = remoteRaw ? redactGitOutput(remoteRaw) : null;
    const latestTag = await tryGit(repoPath, [
      "describe",
      "--tags",
      "--abbrev=0",
    ]);
    const dirty =
      (await gitValue(repoPath, ["status", "--porcelain"])).length > 0;

    return SourceRepositoryStatusSchema.parse({
      spec,
      displayName: definition.displayName,
      repoPath,
      state: activeOperation ? "busy" : dirty ? "dirty" : "ready",
      exists: true,
      isGitRepo: true,
      valid: true,
      currentCommit,
      latestTag,
      branch,
      remoteUrl,
      originMatches: remoteRaw ? remoteRaw === spec.originUrl : false,
      dirty,
      tracking: definition.tracking,
      driftSupported: definition.driftSupported,
      activeOperation,
      checkedAt: nowIso(),
      error: null,
    });
  } catch (error) {
    const failed = emptyStatus(spec, {
      state: "error",
      exists: true,
      activeOperation,
      error: (error as Error).message,
    });
    return SourceRepositoryStatusSchema.parse({
      ...failed,
      isGitRepo: true,
    });
  }
}

export function listSourceRepositoryStatuses(): Promise<
  SourceRepositoryStatus[]
> {
  return Promise.all(
    listSourceRepositoryDefinitions().map((definition) =>
      getSourceRepositoryStatus(definition.id),
    ),
  );
}

export async function assertSourceRepositoryReady(
  sourceId: string,
): Promise<SourceRepositoryStatus> {
  const status = await getSourceRepositoryStatus(sourceId);
  if (!status.valid) {
    throw new Error(
      status.error ?? `source repository ${sourceId} is not ready`,
    );
  }
  return status;
}
