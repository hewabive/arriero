import {
  BuildSettingsSchema,
  pathCatalogBinaryEngineKind,
  type BuildJob,
  type BuildJobStep,
  type BuildJobStepName,
  type BuildJobStatus,
  type BuildSettings,
  type PathCatalogEntry,
} from "@arriero/core";
import { basename, resolve } from "node:path";
import { createJobStore } from "../jobs/store.js";
import { newId } from "../utils/id.js";

import { config } from "../config.js";
import { isCudaToolkitAvailable } from "./cuda.js";
import {
  getLlamaSourceSettings,
  getLlamaSourceVersionLabel,
  saveLlamaSourceSettings,
} from "../llama/source-repository.js";
import { readSettings, writeSettings } from "../settings/store.js";
import {
  createPathCatalogEntry,
  listPathCatalogEntries,
  updatePathCatalogEntry,
} from "../path-catalog/repository.js";

function normalizeBuildsBaseDir(value: string): string {
  const resolved = resolve(value);
  if (resolved === resolve(config.buildsDir, "build")) {
    return resolve(config.buildsDir);
  }
  return resolved;
}

function defaultSettings(
  repoPath = getLlamaSourceSettings().repoPath,
): BuildSettings {
  return {
    repoPath,
    buildDir: resolve(config.buildsDir),
    buildType: "Release",
    buildProfile: "server",
    cuda: isCudaToolkitAvailable(),
    rpc: false,
    native: true,
    cudaArchitectures: null,
    cudaFaAllQuants: false,
    cudaGraphs: "default",
    cudaNoVmm: false,
    llguidance: "default",
    extraCmakeArgs: [],
    env: {},
    target: "llama-server",
    parallelJobs: null,
  };
}

export function getBuildSettings(): BuildSettings {
  const sourceSettings = getLlamaSourceSettings();
  const stored = readSettings().build;
  const settings = stored
    ? BuildSettingsSchema.parse({
        ...stored,
        repoPath: sourceSettings.repoPath,
      })
    : defaultSettings(sourceSettings.repoPath);
  return {
    ...settings,
    repoPath: sourceSettings.repoPath,
    buildDir: normalizeBuildsBaseDir(settings.buildDir),
  };
}

export function saveBuildSettings(input: BuildSettings): BuildSettings {
  const parsed = BuildSettingsSchema.parse(input);
  if (resolve(parsed.repoPath) !== resolve(getLlamaSourceSettings().repoPath)) {
    saveLlamaSourceSettings({ repoPath: parsed.repoPath });
  }
  writeSettings({
    ...readSettings(),
    build: { ...parsed },
  });
  return getBuildSettings();
}

function uniqueBinaryName(desired: string, excludeId: string | null): string {
  const taken = new Set(
    listPathCatalogEntries("binary")
      .filter((entry) => entry.id !== excludeId)
      .map((entry) => entry.name),
  );
  if (!taken.has(desired)) {
    return desired;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = ` #${suffix}`;
    const candidate = `${desired.slice(0, 80 - tag.length)}${tag}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function registerBuiltBinaryInCatalog(
  binaryPath: string,
  repoPath: string,
  ref: string | null = null,
): PathCatalogEntry {
  const version = getLlamaSourceVersionLabel(repoPath);
  const base = basename(binaryPath);
  const detail = [ref, version].filter(Boolean).join(" @ ");
  const desired = (detail ? `${base} (${detail})` : base).slice(0, 80);
  const engineKind = pathCatalogBinaryEngineKind({ path: binaryPath });
  const existing = listPathCatalogEntries("binary").find(
    (entry) => entry.path === binaryPath,
  );
  if (existing) {
    const name = uniqueBinaryName(desired, existing.id);
    return (
      updatePathCatalogEntry(existing.id, { name, engineKind }) ?? existing
    );
  }
  const name = uniqueBinaryName(desired, null);
  return createPathCatalogEntry({
    kind: "binary",
    name,
    path: binaryPath,
    engineKind,
  });
}

const BUILD_JOB_HISTORY_LIMIT = 20;

export const buildJobs = createJobStore<BuildJob>({
  historyLimit: BUILD_JOB_HISTORY_LIMIT,
});

export function createBuildJob(input: {
  status: BuildJobStatus;
  settings: BuildSettings;
  steps: BuildJobStep[];
  currentStep: BuildJobStepName | null;
  startedAt: string;
  logPath: string;
}): BuildJob {
  return buildJobs.insert({
    id: newId(),
    status: input.status,
    settings: input.settings,
    steps: input.steps,
    currentStep: input.currentStep,
    startedAt: input.startedAt,
    finishedAt: null,
    exitCode: null,
    logPath: input.logPath,
    binaryPath: null,
    error: null,
  });
}

export function updateBuildJob(
  id: string,
  input: Partial<{
    status: BuildJobStatus;
    steps: BuildJobStep[];
    currentStep: BuildJobStepName | null;
    finishedAt: string | null;
    exitCode: number | null;
    binaryPath: string | null;
    error: string | null;
  }>,
): BuildJob | null {
  return buildJobs.patch(id, input);
}

export function getBuildJob(id: string): BuildJob | null {
  return buildJobs.get(id);
}

export function listBuildJobs(limit = 20): BuildJob[] {
  return buildJobs.list(limit);
}
