import {
  BuildSettingsSchema,
  pathCatalogBinaryEngineKind,
  type BuildJob,
  type BuildJobStep,
  type BuildJobStepName,
  type BuildJobStatus,
  type BuildSettings,
  type PathCatalogEntry,
} from "@llama-manager/core";
import { basename, resolve } from "node:path";
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
  saveLlamaSourceSettings({ repoPath: parsed.repoPath });
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
const buildJobs = new Map<string, BuildJob>();

function cloneJob(job: BuildJob): BuildJob {
  return structuredClone(job);
}

function trimBuildJobHistory() {
  if (buildJobs.size <= BUILD_JOB_HISTORY_LIMIT) {
    return;
  }
  const removable = [...buildJobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const job of removable) {
    if (buildJobs.size <= BUILD_JOB_HISTORY_LIMIT) {
      break;
    }
    buildJobs.delete(job.id);
  }
}

export function createBuildJob(input: {
  status: BuildJobStatus;
  settings: BuildSettings;
  steps: BuildJobStep[];
  currentStep: BuildJobStepName | null;
  startedAt: string;
  logPath: string;
}): BuildJob {
  const job: BuildJob = {
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
  };
  buildJobs.set(job.id, cloneJob(job));
  trimBuildJobHistory();
  return cloneJob(job);
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
  const current = buildJobs.get(id);
  if (!current) {
    return null;
  }

  const next: BuildJob = {
    ...current,
    status: input.status ?? current.status,
    steps: input.steps ?? current.steps,
    currentStep:
      input.currentStep === undefined ? current.currentStep : input.currentStep,
    finishedAt:
      input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
    exitCode: input.exitCode === undefined ? current.exitCode : input.exitCode,
    binaryPath:
      input.binaryPath === undefined ? current.binaryPath : input.binaryPath,
    error: input.error === undefined ? current.error : input.error,
  };

  buildJobs.set(id, cloneJob(next));
  return cloneJob(next);
}

export function getBuildJob(id: string): BuildJob | null {
  const job = buildJobs.get(id);
  return job ? cloneJob(job) : null;
}

export function listBuildJobs(limit = 20): BuildJob[] {
  return [...buildJobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(cloneJob);
}
