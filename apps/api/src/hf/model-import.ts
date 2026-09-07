import {
  discoverModelImports,
  type DiscoveredImport,
} from "./import-discovery.js";
import { selectImportPlan } from "./import-selection.js";
import type { ModelImportSelection } from "@arriero/core";
import { importFileIdentity } from "./import-content.js";
import type { ModelPresetDocument } from "@arriero/core";
import { listPresets, readPreset, writePreset } from "../presets/repository.js";
import { renderModelPresetFile } from "../presets/ini.js";
import { clearHfUpdateCheck } from "./update-check.js";
import { registerActiveJob } from "../jobs/registry.js";
import {
  type Instance,
  type ModelImportRequest,
  type ModelImportState,
} from "@arriero/core";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  unlink,
  rmdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { listInstances, updateInstance } from "../instances/repository.js";
import { logger } from "../logger.js";
import { startModelScan } from "../models/scan-runner.js";
import { isPathWithin } from "../path-utils.js";
import type { HfClientOptions } from "./client.js";
import { getHfDownloadQueueState } from "./download-queue.js";
import { HfDownloadConflictError } from "./download-plan.js";
import { invalidateHfDownloadsCache } from "./downloads.js";
import { hfDeleteBlockers, listLiveProcessArgs } from "./in-use.js";
import { lockModelImport } from "./import-lock.js";
import {
  readHfManifest,
  writeHfManifest,
  hfManifestPath,
  type HfManifest,
} from "./manifest.js";
import {
  collectImportFiles,
  type ModelImportPlan,
} from "./model-import-plan.js";
import { HfDownloadRequestError } from "./paths.js";
import { captureModelLibraryEntry } from "./model-library.js";

const jobs = new Map<
  string,
  {
    state: ModelImportState;
    plan: ModelImportPlan | null;
    candidates: DiscoveredImport[];
    controller: AbortController;
  }
>();

async function assertDestinationPath(path: string): Promise<void> {
  let parent = dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  if ((await realpath(parent)) !== parent)
    throw new HfDownloadConflictError(
      `Destination uses a symbolic link: ${parent}`,
    );
}

function importDirectories(plan: ModelImportPlan): string[] {
  return [
    ...new Set([
      plan.state.destDir,
      ...(plan.directory
        ? [plan.source]
        : plan.files.map((file) => dirname(file.path))),
    ]),
  ];
}

function assertImportIdle(plan: ModelImportPlan): void {
  const queue = getHfDownloadQueueState();
  const dirs = importDirectories(plan);
  if (
    [queue.active, ...queue.queued, ...queue.paused].some(
      (job) =>
        job &&
        dirs.some(
          (dir) =>
            isPathWithin(dir, job.destDir) || isPathWithin(job.destDir, dir),
        ),
    )
  )
    throw new HfDownloadConflictError(
      "Remove or finish overlapping download jobs before importing",
    );
  if (
    !plan.state.files.some(
      (file) => file.source !== file.destination && !file.keepSource,
    )
  )
    return;
  const blockers = hfDeleteBlockers(
    {
      dir: plan.directory ? plan.source : dirname(plan.source),
      paths: plan.directory
        ? null
        : plan.files
            .filter(
              (file) =>
                !plan.state.files.find((entry) => entry.source === file.path)
                  ?.keepSource,
            )
            .map((file) => file.relative),
    },
    listLiveProcessArgs(),
  );
  for (const summary of listPresets()) {
    const preset = readPreset(summary.name);
    if (
      !preset ||
      JSON.stringify(remapPaths(preset.file, plan)) ===
        JSON.stringify(preset.file)
    )
      continue;
    for (const process of listLiveProcessArgs()) {
      if (process.cliArgs.some((arg) => arg.includes(preset.path)))
        blockers.push(process.instanceId);
    }
  }
  if (blockers.length)
    throw new HfDownloadConflictError(
      `Stop instances before importing: ${blockers.join(", ")}`,
    );
}

async function validatePlan(
  plan: ModelImportPlan,
  checkBusy = true,
): Promise<HfManifest | null> {
  if (checkBusy) assertImportIdle(plan);
  const current = plan.directory
    ? await collectImportFiles(plan.source, true)
    : await Promise.all(
        plan.files.map(async (file) => ({
          ...file,
          identity: await importFileIdentity(file.path),
        })),
      );
  for (const file of plan.files)
    if ((await realpath(file.path)) !== file.path)
      throw new HfDownloadConflictError(
        `Source now uses a symbolic link: ${file.path}`,
      );
  if (JSON.stringify(current) !== JSON.stringify(plan.files))
    throw new HfDownloadConflictError(
      "Source changed since verification; check it again",
    );
  const existing = readHfManifest(plan.state.destDir);
  if (existsSync(hfManifestPath(plan.state.destDir)) && !existing)
    throw new HfDownloadConflictError("Destination manifest is invalid");
  if (existing && existing.repoId !== plan.state.repoId)
    throw new HfDownloadConflictError(
      "Destination belongs to a different repository",
    );
  for (const file of plan.state.files) {
    await assertDestinationPath(file.destination);
    try {
      await lstat(file.destination);
      if (file.destination !== file.source)
        throw new HfDownloadConflictError(
          `Destination already exists: ${file.destination}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

function remapPaths<Value>(input: Value, plan: ModelImportPlan): Value {
  const mappings = plan.state.files
    .filter((file) => !file.keepSource)
    .map((file) => [file.source, file.destination] as const);
  if (plan.directory) {
    const first = plan.state.files[0];
    const original = plan.files[0];
    if (first && original)
      mappings.push([
        plan.source,
        first.destination
          .slice(0, -original.relative.length)
          .replace(/\/$/, ""),
      ]);
  }
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const [source, destination] of mappings) {
        if (value === source) return destination;
        if (value.startsWith(`${source}/`))
          return destination + value.slice(source.length);
        if (value.endsWith(`=${source}`))
          return value.slice(0, -source.length) + destination;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replace(entry)]),
      );
    return value;
  };
  return replace(input) as Value;
}

async function pruneEmptyDirectories(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      await pruneEmptyDirectories(join(path, entry.name));
  }
  if ((await readdir(path)).length === 0) await rmdir(path);
}

async function executeImport(
  plan: ModelImportPlan,
  signal: AbortSignal,
): Promise<void> {
  const release = lockModelImport(importDirectories(plan));
  let staging: string | null = null;
  const published: string[] = [];
  const updated: Instance[] = [];
  const updatedPresets: ModelPresetDocument[] = [];
  let previousManifest: HfManifest | null = null;
  let manifestWritten = false;
  let committed = false;
  try {
    previousManifest = await validatePlan(plan);
    await mkdir(plan.state.destDir, { recursive: true });
    if (plan.state.files.some((file) => file.source !== file.destination))
      staging = await mkdtemp(join(plan.state.destDir, ".arriero-import-"));
    plan.state.completed = 0;
    plan.state.total = plan.state.files.length;
    for (const [index, file] of plan.state.files.entries()) {
      signal.throwIfAborted();
      plan.state.currentFile = file.source;
      if (file.source !== file.destination) {
        const staged = join(staging!, String(index));
        try {
          if (file.keepSource)
            await copyFile(file.source, staged, constants.COPYFILE_EXCL);
          else await link(file.source, staged);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(file.source, staged, constants.COPYFILE_EXCL);
        }
      }
      plan.state.completed++;
    }
    for (const file of plan.files) {
      const current = await lstat(file.path, { bigint: true });
      const previous = file.identity.split(":");
      if (
        [current.dev, current.ino, current.size, current.mtimeNs].join(":") !==
        previous.slice(0, 4).join(":")
      )
        throw new HfDownloadConflictError(
          `Source changed during import: ${file.path}`,
        );
      file.identity = await importFileIdentity(file.path);
    }
    await validatePlan(plan);
    for (const [index, file] of plan.state.files.entries()) {
      if (file.source === file.destination) continue;
      await mkdir(dirname(file.destination), { recursive: true });
      await assertDestinationPath(file.destination);
      await link(join(staging!, String(index)), file.destination);
      published.push(file.destination);
    }
    signal.throwIfAborted();
    assertImportIdle(plan);
    const retained =
      previousManifest?.files.filter(
        (file) => !plan.manifestFiles.some((entry) => entry.path === file.path),
      ) ?? [];
    writeHfManifest(plan.state.destDir, {
      version: 1,
      repoId: plan.state.repoId,
      revision: plan.state.revision,
      downloadedAt: previousManifest?.downloadedAt ?? new Date().toISOString(),
      importedAt: new Date().toISOString(),
      acquisition: previousManifest ? "mixed" : "imported",
      files: [...retained, ...plan.manifestFiles],
    });
    manifestWritten = true;
    for (const instance of listInstances()) {
      const next = remapPaths(instance, plan);
      if (JSON.stringify(next) === JSON.stringify(instance)) continue;
      updateInstance(instance.name, next);
      updated.push(instance);
    }
    for (const summary of listPresets()) {
      const preset = readPreset(summary.name);
      if (!preset) continue;
      const next = remapPaths(preset.file, plan);
      if (JSON.stringify(next) === JSON.stringify(preset.file)) continue;
      if (!preset.valid)
        throw new HfDownloadConflictError(
          `Fix invalid preset before importing: ${preset.name}`,
        );
      const result = writePreset(preset.name, {
        content: renderModelPresetFile(next),
        expectedMtimeMs: preset.mtimeMs,
        force: false,
      });
      if (result.kind !== "ok")
        throw new HfDownloadConflictError(
          `Preset changed during import: ${preset.name}`,
        );
      updatedPresets.push(preset);
    }
    committed = true;
    clearHfUpdateCheck(plan.state.destDir);
    captureModelLibraryEntry({
      repoId: plan.state.repoId,
      revision: plan.state.revision,
      destDir: plan.state.destDir,
      files: plan.manifestFiles,
    });
    for (const file of plan.state.files) {
      if (file.source === file.destination || file.keepSource) continue;
      try {
        const source = plan.files.find((entry) => entry.path === file.source)!;
        const identity = await importFileIdentity(file.source);
        const stable = (value: string) =>
          value.split(":").slice(0, 4).join(":");
        if (stable(identity) !== stable(source.identity))
          throw new Error(
            "Source changed after publication; original was retained",
          );
        await unlink(file.source);
      } catch (error) {
        logger.warn(
          { err: error, path: file.source },
          "import source cleanup failed",
        );
        plan.state.warnings.push(
          `Imported, but could not remove original: ${file.source}`,
        );
      }
    }
    if (plan.directory && plan.source !== plan.state.destDir) {
      try {
        await pruneEmptyDirectories(plan.source);
      } catch (error) {
        logger.warn(
          { err: error, path: plan.source },
          "import directory cleanup failed",
        );
        plan.state.warnings.push(
          `Could not remove empty source directories: ${plan.source}`,
        );
      }
    }
  } catch (error) {
    if (!committed) {
      let rollbackFailed = false;
      for (const preset of updatedPresets.reverse()) {
        try {
          const result = writePreset(preset.name, {
            content: preset.content,
            expectedMtimeMs: null,
            force: true,
          });
          if (result.kind !== "ok")
            throw new Error(`Cannot restore preset ${preset.name}`);
        } catch (rollbackError) {
          rollbackFailed = true;
          logger.error({ err: rollbackError }, "import preset rollback failed");
        }
      }
      for (const instance of updated.reverse()) {
        try {
          updateInstance(instance.name, instance);
        } catch (rollbackError) {
          rollbackFailed = true;
          logger.error(
            { err: rollbackError },
            "import instance rollback failed",
          );
        }
      }
      if (!rollbackFailed) {
        if (manifestWritten) {
          if (previousManifest)
            writeHfManifest(plan.state.destDir, previousManifest);
          else await rm(hfManifestPath(plan.state.destDir));
        }
        for (const path of published) await unlink(path);
      } else
        plan.state.warnings.push(
          "Reference rollback failed; both source and destination copies were retained.",
        );
    }
    throw error;
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      release();
      invalidateHfDownloadsCache();
      startModelScan({ refresh: true });
    }
  }
}

function fail(state: ModelImportState, error: unknown): void {
  state.status = "failed";
  state.error = error instanceof Error ? error.message : String(error);
  state.currentFile = null;
  logger.warn({ err: error, importId: state.id }, "model import failed");
}

async function prepareSelection(
  job: {
    state: ModelImportState;
    plan: ModelImportPlan | null;
    candidates: DiscoveredImport[];
    controller: AbortController;
  },
  selection: ModelImportSelection,
): Promise<ModelImportState> {
  const candidate = job.candidates.find(
    (entry) => entry.candidate.id === selection.candidateId,
  );
  if (!candidate)
    throw new HfDownloadRequestError(
      "Repository candidate is unavailable; search again",
    );
  const plan = selectImportPlan(candidate, selection, job.state);
  job.plan = plan;
  job.state.currentFile = null;
  job.state.blockers = [];
  try {
    await validatePlan(plan, false);
  } catch (error) {
    job.state.blockers.push((error as Error).message);
  }
  try {
    assertImportIdle(plan);
  } catch (error) {
    job.state.blockers.push((error as Error).message);
  }
  job.state.status = job.controller.signal.aborted ? "canceled" : "ready";
  return job.state;
}

export function startModelImport(
  input: ModelImportRequest,
  options?: HfClientOptions,
): ModelImportState {
  if (
    [...jobs.values()].some((job) =>
      ["searching", "checking", "importing"].includes(job.state.status),
    )
  )
    throw new HfDownloadConflictError(
      "Another model import is running; reopen it or cancel it first",
    );
  if (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
  const controller = new AbortController();
  const state: ModelImportState = {
    id: randomUUID(),
    scope: input.scope,
    status: input.repo ? "checking" : "searching",
    sourcePath: input.sourcePath,
    destDir: "",
    repoId: "",
    revision: "",
    files: [],
    completed: 0,
    total: 0,
    currentFile: null,
    error: null,
    warnings: [],
    candidates: [],
    selectedCandidateId: null,
    searchedRepositories: 0,
    searchTruncated: false,
    blockers: [],
  };
  const job = {
    state,
    plan: null as ModelImportPlan | null,
    candidates: [] as DiscoveredImport[],
    controller,
  };
  jobs.set(state.id, job);
  const completion = discoverModelImports(
    input,
    state,
    options,
    controller.signal,
  )
    .then(async (candidates) => {
      controller.signal.throwIfAborted();
      job.candidates = candidates;
      state.candidates = candidates.map((entry) => entry.candidate);
      state.currentFile = null;
      if (candidates.length === 1) {
        await prepareSelection(job, {
          id: state.id,
          candidateId: candidates[0]!.candidate.id,
          companions: [],
          destinations: {},
          keepCompanions: true,
        });
      } else state.status = "choosing";
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        state.status = "canceled";
        state.currentFile = null;
      } else fail(state, error);
    });
  registerActiveJob({
    domain: "model-import",
    entityId: `${state.id}:search`,
    jobId: state.id,
    cancel: () => controller.abort(),
    completion,
  });
  return state;
}

export function listModelImports(): ModelImportState[] {
  return [...jobs.values()].map((job) => job.state).reverse();
}
export function getModelImport(id: string): ModelImportState | null {
  return jobs.get(id)?.state ?? null;
}
export function selectModelImport(
  input: ModelImportSelection,
): Promise<ModelImportState> {
  const job = jobs.get(input.id);
  if (!job || !["choosing", "ready"].includes(job.state.status))
    throw new HfDownloadRequestError("Import is not ready for selection");
  job.state.status = "checking";
  return prepareSelection(job, input).catch((error: unknown) => {
    job.state.status = "choosing";
    throw error;
  });
}
export function cancelModelImport(id: string): ModelImportState {
  const job = jobs.get(id);
  if (!job) throw new HfDownloadRequestError("Import is unavailable");
  job.controller.abort();
  if (["choosing", "ready"].includes(job.state.status))
    job.state.status = "canceled";
  return job.state;
}
export function commitModelImport(id: string): ModelImportState {
  const job = jobs.get(id);
  if (!job || !job.plan || job.state.status !== "ready")
    throw new HfDownloadRequestError(
      "Import preview is unavailable; verify the source again",
    );
  assertImportIdle(job.plan);
  job.state.status = "importing";
  job.state.error = null;
  const controller = new AbortController();
  job.controller = controller;
  const completion = executeImport(job.plan, controller.signal)
    .then(() => {
      job.state.status = "succeeded";
      job.state.currentFile = null;
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        job.state.status = "canceled";
        job.state.currentFile = null;
      } else fail(job.state, error);
    });
  registerActiveJob({
    domain: "model-import",
    entityId: `${job.state.id}:import`,
    jobId: job.state.id,
    cancel: () => controller.abort(),
    completion,
  });
  return job.state;
}
