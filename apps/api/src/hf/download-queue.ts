import type {
  HfDownloadQueueJob,
  HfDownloadQueueState,
  HfDownloadStart,
} from "@arriero/core";
import { mkdirSync } from "node:fs";

import { registerActiveJob, resetActiveJobs } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { startModelScan } from "../models/scan-runner.js";
import { getHfDownloadSettings } from "../settings/downloads.js";
import { newId } from "../utils/id.js";
import type { HfClientOptions } from "./client.js";
import {
  hfDownloadSpaceError,
  planHfDownload,
  plannedFileFor,
  type FreeBytesImpl,
  type HfPlannedFile,
} from "./download-plan.js";
import {
  HF_DOWNLOAD_JOB_DOMAIN,
  invalidateHfDownloadsCache,
} from "./downloads.js";
import {
  ensureHfManifestHeader,
  readHfManifest,
  upsertHfManifestFile,
} from "./manifest.js";
import {
  loadHfQueueStore,
  persistHfQueueStore,
  type HfQueueJob,
} from "./queue-store.js";
import { runHfTransfer } from "./transfer-engine.js";
import {
  createHfTransferTelemetry,
  hfTransferSnapshot,
  recordHfTransferPayload,
  recordHfTransferReset,
  recordHfTransferWire,
  type HfTransferTelemetry,
} from "./transfer-telemetry.js";
import { clearHfUpdateCheck, runHfUpdateChecks } from "./update-check.js";

const HISTORY_LIMIT = 20;
const SLOW_ETA_MEASURE_MS = 90_000;
const SLOW_ETA_CHECK_INTERVAL_MS = 5_000;

export type HfDownloadQueueOptions = {
  fetchImpl?: typeof fetch | undefined;
  token?: string | null | undefined;
  freeBytes?: FreeBytesImpl | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
};

export type HfQueueMutationResult =
  | { ok: true; state: HfDownloadQueueState }
  | { ok: false; status: 400 | 404 | 409; error: string };

type ActiveRun = {
  jobId: string;
  controller: AbortController;
  completion: Promise<void>;
};

type QueueState = {
  queue: HfQueueJob[];
  history: HfQueueJob[];
  resumedAtLoad: number;
};

let state: QueueState | null = null;
let currentRun: ActiveRun | null = null;
let shuttingDown = false;
let currentConnections: number | null = null;
let currentTelemetry: HfTransferTelemetry | null = null;
let slowEtaTrigger: string | null = null;
let fallbackJobOptions: HfDownloadQueueOptions | null = null;
const jobOptions = new Map<string, HfDownloadQueueOptions>();
const liveBytes = new Map<string, number>();
const pendingBaselinePaths = new Set<string>();
const userCanceledPaths = new Set<string>();
const fileAborts = new Map<string, () => void>();

function nowIso(): string {
  return new Date().toISOString();
}

function ensureState(): QueueState {
  if (state) {
    return state;
  }
  const stored = loadHfQueueStore();
  let resumed = 0;
  for (const job of stored.queue) {
    job.pauseRequested = false;
    if (job.status === "running") {
      job.status = "queued";
      job.message = "Interrupted by a manager restart.";
      resumed += 1;
    }
    for (const file of job.files) {
      if (file.status === "downloading") {
        file.status = "pending";
      }
    }
  }
  state = {
    queue: stored.queue,
    history: stored.history,
    resumedAtLoad: resumed,
  };
  if (resumed > 0) {
    persist();
  }
  return state;
}

function persist(): void {
  const current = ensureState();
  persistHfQueueStore({
    version: 1,
    queue: current.queue,
    history: current.history,
  });
}

function optionsFor(job: HfQueueJob): HfDownloadQueueOptions | null {
  return jobOptions.get(job.id) ?? fallbackJobOptions;
}

function clientOptionsFor(job: HfQueueJob): HfClientOptions {
  const options = optionsFor(job);
  const clientOptions: HfClientOptions = {};
  if (options?.fetchImpl) {
    clientOptions.fetchImpl = options.fetchImpl;
  }
  if (options && options.token !== undefined) {
    clientOptions.token = options.token;
  }
  return clientOptions;
}

function fileBytes(job: HfQueueJob, path: string, fallback: number): number {
  if (currentRun?.jobId === job.id) {
    const live = liveBytes.get(path);
    if (live !== undefined) {
      return live;
    }
  }
  return fallback;
}

function toApiJob(job: HfQueueJob): HfDownloadQueueJob {
  const isActive = currentRun?.jobId === job.id && job.status === "running";
  const files = job.files.map((file) => ({
    path: file.path,
    size: file.size,
    status: file.status,
    downloadedBytes: Math.min(
      fileBytes(job, file.path, file.downloadedBytes),
      file.size,
    ),
    error: file.error,
  }));
  const downloadedBytes = files.reduce(
    (sum, file) => sum + file.downloadedBytes,
    0,
  );
  return {
    id: job.id,
    repoId: job.repoId,
    revision: job.revision,
    destDir: job.destDir,
    status: job.status,
    message: job.message,
    error: job.error,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancelRequested: job.cancelRequested,
    pauseRequested: job.pauseRequested,
    pauseReason: job.pauseReason,
    slowEtaOverride: job.slowEtaOverride,
    totalBytes: job.totalBytes,
    downloadedBytes,
    activePaths: isActive
      ? files
          .filter((file) => file.status === "downloading")
          .map((file) => file.path)
      : [],
    connections: isActive ? currentConnections : null,
    transfer:
      isActive && currentTelemetry
        ? hfTransferSnapshot(
            currentTelemetry,
            Math.max(0, job.totalBytes - downloadedBytes),
            Date.now(),
          )
        : null,
    files,
  };
}

export function getHfDownloadQueueState(): HfDownloadQueueState {
  const current = ensureState();
  const active = current.queue.find((job) => job.status === "running") ?? null;
  return {
    active: active ? toApiJob(active) : null,
    queued: current.queue
      .filter((job) => job.status === "queued")
      .map(toApiJob),
    paused: current.queue
      .filter((job) => job.status === "paused")
      .map(toApiJob),
    history: current.history.map(toApiJob),
  };
}

function patchFile(
  job: HfQueueJob,
  path: string,
  patch: Partial<Omit<HfQueueJob["files"][number], "path">>,
): void {
  const file = job.files.find((entry) => entry.path === path);
  if (file) {
    Object.assign(file, patch);
  }
}

function isModelFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".gguf") || lower.endsWith(".safetensors");
}

type TransferOutcome = {
  failedCount: number;
  fatalError: string | null;
  stalled: string | null;
  downloadedModelFile: boolean;
};

async function executeJob(
  job: HfQueueJob,
  signal: AbortSignal,
): Promise<TransferOutcome> {
  const clientOptions = clientOptionsFor(job);
  const pendingFiles = job.files.filter((file) => file.status === "pending");
  const planned: HfPlannedFile[] = pendingFiles.map((file) =>
    plannedFileFor(job.destDir, file),
  );
  const spaceError = await hfDownloadSpaceError(
    planned,
    job.destDir,
    optionsFor(job)?.freeBytes,
  );
  if (spaceError) {
    return {
      failedCount: 0,
      fatalError: spaceError,
      stalled: null,
      downloadedModelFile: false,
    };
  }
  mkdirSync(job.destDir, { recursive: true });
  ensureHfManifestHeader(job.destDir, {
    repoId: job.repoId,
    revision: job.revision,
  });
  const manifest = readHfManifest(job.destDir);
  const manifestEntries = new Map(
    manifest?.files.map((file) => [file.path, file]) ?? [],
  );
  let downloadedModelFile = false;
  const settings = getHfDownloadSettings();
  currentConnections = settings.connections;
  const now = optionsFor(job)?.now ?? Date.now;
  const telemetry = createHfTransferTelemetry(now());
  currentTelemetry = telemetry;
  const maxEtaHours = settings.maxEtaHours;
  let lastEtaCheckAt = telemetry.startedAt;
  const maybePauseOnSlowEta = (at: number) => {
    if (
      maxEtaHours === null ||
      job.slowEtaOverride ||
      slowEtaTrigger !== null ||
      at - telemetry.startedAt < SLOW_ETA_MEASURE_MS ||
      at - lastEtaCheckAt < SLOW_ETA_CHECK_INTERVAL_MS
    ) {
      return;
    }
    lastEtaCheckAt = at;
    const elapsedSeconds = (at - telemetry.startedAt) / 1_000;
    const averageBps = telemetry.payloadBytes / elapsedSeconds;
    if (averageBps <= 0) {
      return;
    }
    const downloaded = job.files.reduce(
      (sum, file) =>
        sum +
        Math.min(fileBytes(job, file.path, file.downloadedBytes), file.size),
      0,
    );
    const remaining = Math.max(0, job.totalBytes - downloaded);
    const etaSeconds = remaining / averageBps;
    if (etaSeconds <= maxEtaHours * 3_600) {
      return;
    }
    slowEtaTrigger = `projected finish in ${Math.round(etaSeconds / 3_600)} h exceeds the ${maxEtaHours} h limit at the current rate`;
    currentRun?.controller.abort();
  };
  const result = await runHfTransfer({
    repoId: job.repoId,
    sha: job.revision,
    planned,
    signal,
    clientOptions,
    manifestEntries,
    connections: settings.connections,
    chunkBytes: settings.chunkBytes,
    isFileCanceled: (path) => userCanceledPaths.has(path),
    fileAborts,
    sleep: optionsFor(job)?.sleep,
    events: {
      onFileStart: (path) => {
        patchFile(job, path, { status: "downloading" });
        liveBytes.set(path, 0);
        pendingBaselinePaths.add(path);
        job.message = `Downloading ${path}`;
      },
      onFileBytes: (path, bytes) => {
        const previous = liveBytes.get(path) ?? 0;
        liveBytes.set(path, bytes);
        if (pendingBaselinePaths.delete(path)) {
          return;
        }
        if (bytes > previous) {
          const at = now();
          recordHfTransferPayload(telemetry, bytes - previous, at);
          maybePauseOnSlowEta(at);
        }
      },
      onWireBytes: (deltaBytes) => {
        recordHfTransferWire(telemetry, deltaBytes, now());
      },
      onTransportError: () => {
        recordHfTransferReset(telemetry);
      },
      onFileFinished: (file, outcome) => {
        upsertHfManifestFile(
          job.destDir,
          { repoId: job.repoId, revision: job.revision },
          {
            path: file.path,
            size: file.size,
            oid: file.oid,
            lfsOid: file.lfs?.oid ?? null,
            lastCommitId: file.lastCommitId,
            lastCommitDate: file.lastCommitDate,
          },
        );
        invalidateHfDownloadsCache();
        if (outcome === "succeeded" && isModelFilePath(file.path)) {
          downloadedModelFile = true;
        }
        patchFile(job, file.path, {
          status: outcome,
          downloadedBytes: file.size,
          error: null,
        });
        liveBytes.delete(file.path);
        persist();
      },
      onFileFailed: (path, message) => {
        patchFile(job, path, {
          status: "failed",
          error: message,
          downloadedBytes: liveBytes.get(path) ?? 0,
        });
        liveBytes.delete(path);
        persist();
      },
      onFileCanceled: (path) => {
        patchFile(job, path, {
          status: "canceled",
          downloadedBytes: liveBytes.get(path) ?? 0,
        });
        liveBytes.delete(path);
        persist();
      },
    },
  });
  return { ...result, downloadedModelFile };
}

function finalizeJob(
  job: HfQueueJob,
  input: {
    aborted: boolean;
    failedCount: number;
    fatalError: string | null;
    stalled: string | null;
  },
): "finished" | "requeued" | "paused" | "orphaned" {
  const current = ensureState();
  if (!current.queue.some((entry) => entry.id === job.id)) {
    return "orphaned";
  }
  for (const file of job.files) {
    if (file.status === "downloading") {
      file.downloadedBytes = Math.min(
        liveBytes.get(file.path) ?? file.downloadedBytes,
        file.size,
      );
    }
  }
  if (input.aborted && shuttingDown && !job.cancelRequested) {
    job.status = "queued";
    job.message = "Interrupted by manager shutdown.";
    for (const file of job.files) {
      if (file.status === "downloading") {
        file.status = "pending";
      }
    }
    persist();
    return "requeued";
  }
  const pauseReason =
    input.aborted && job.pauseRequested && !job.cancelRequested
      ? "manual"
      : input.aborted && slowEtaTrigger !== null && !job.cancelRequested
        ? "slow-eta"
        : !input.aborted && input.stalled !== null
          ? "network"
          : null;
  if (pauseReason !== null) {
    job.status = "paused";
    job.pauseReason = pauseReason;
    job.pauseRequested = false;
    job.error = null;
    job.message =
      pauseReason === "network"
        ? `Paused: no download progress (${input.stalled}).`
        : pauseReason === "slow-eta"
          ? `Paused: ${slowEtaTrigger}.`
          : "Paused by user.";
    for (const file of job.files) {
      if (file.status === "downloading") {
        file.status = "pending";
      }
    }
    persist();
    return "paused";
  }
  job.pauseRequested = false;
  for (const file of job.files) {
    if (file.status === "pending" || file.status === "downloading") {
      file.status = "canceled";
    }
  }
  const status = input.aborted
    ? "canceled"
    : input.fatalError || input.failedCount > 0
      ? "failed"
      : "succeeded";
  const completed = job.files.filter(
    (file) => file.status === "succeeded" || file.status === "skipped",
  ).length;
  job.status = status;
  job.error = input.aborted
    ? "canceled by user"
    : (input.fatalError ??
      (input.failedCount > 0
        ? `${input.failedCount} of ${job.files.length} files failed`
        : null));
  job.message =
    status === "succeeded"
      ? `Downloaded ${completed} of ${job.files.length} files.`
      : status === "canceled"
        ? "Canceled by user."
        : job.error;
  job.finishedAt = nowIso();
  current.queue = current.queue.filter((entry) => entry.id !== job.id);
  current.history = [job, ...current.history].slice(0, HISTORY_LIMIT);
  persist();
  return "finished";
}

async function runActive(
  job: HfQueueJob,
  controller: AbortController,
): Promise<void> {
  let outcome: TransferOutcome = {
    failedCount: 0,
    fatalError: null,
    stalled: null,
    downloadedModelFile: false,
  };
  const clientOptions = clientOptionsFor(job);
  try {
    outcome = await executeJob(job, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      outcome.fatalError = (error as Error).message;
      logger.error(
        { repoId: job.repoId, jobId: job.id, err: error },
        "hf download job crashed",
      );
    }
  } finally {
    const disposition = finalizeJob(job, {
      aborted: controller.signal.aborted,
      failedCount: outcome.failedCount,
      fatalError: outcome.fatalError,
      stalled: outcome.stalled,
    });
    if (currentRun?.jobId === job.id) {
      liveBytes.clear();
      fileAborts.clear();
      userCanceledPaths.clear();
      pendingBaselinePaths.clear();
      currentConnections = null;
      currentTelemetry = null;
      slowEtaTrigger = null;
    }
    invalidateHfDownloadsCache();
    if (disposition === "finished") {
      jobOptions.delete(job.id);
      clearHfUpdateCheck(job.destDir);
      if (job.status === "succeeded") {
        try {
          await runHfUpdateChecks([job.destDir], clientOptions);
        } catch (error) {
          logger.warn(
            { repoId: job.repoId, destDir: job.destDir, err: error },
            "post-download update check failed",
          );
        }
      }
      if (outcome.downloadedModelFile) {
        startModelScan({ refresh: true });
      }
    }
  }
}

function pump(): void {
  if (shuttingDown || currentRun) {
    return;
  }
  const current = ensureState();
  const job = current.queue.find((entry) => entry.status === "queued");
  if (!job) {
    return;
  }
  job.status = "running";
  job.startedAt = job.startedAt ?? nowIso();
  job.message = "Preparing download.";
  persist();
  const controller = new AbortController();
  const completion = runActive(job, controller);
  const run: ActiveRun = { jobId: job.id, controller, completion };
  currentRun = run;
  registerActiveJob({
    domain: HF_DOWNLOAD_JOB_DOMAIN,
    entityId: job.destDir,
    jobId: job.id,
    cancel: () => controller.abort(),
    completion,
  });
  void completion.finally(() => {
    if (currentRun === run) {
      currentRun = null;
    }
    setImmediate(() => pump());
  });
}

export async function enqueueHfDownload(
  input: HfDownloadStart,
  options?: HfDownloadQueueOptions,
): Promise<HfDownloadQueueJob> {
  const current = ensureState();
  const clientOptions: HfClientOptions = {};
  if (options?.fetchImpl) {
    clientOptions.fetchImpl = options.fetchImpl;
  }
  if (options && options.token !== undefined) {
    clientOptions.token = options.token;
  }
  const plan = await planHfDownload(input, clientOptions, options?.freeBytes);
  const job: HfQueueJob = {
    id: newId(),
    repoId: plan.repoId,
    revision: plan.sha,
    destDir: plan.destDir,
    status: "queued",
    message: "Queued.",
    error: null,
    enqueuedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    pauseRequested: false,
    pauseReason: null,
    slowEtaOverride: false,
    totalBytes: plan.totalBytes,
    downloadedBytes: 0,
    files: plan.planned.map((file) => ({
      path: file.path,
      size: file.size,
      status: "pending",
      downloadedBytes: 0,
      error: null,
      oid: file.oid,
      lfs: file.lfs,
      lastCommitId: file.lastCommitId,
      lastCommitDate: file.lastCommitDate,
    })),
  };
  current.queue.push(job);
  if (options) {
    jobOptions.set(job.id, options);
  }
  persist();
  pump();
  return toApiJob(job);
}

export function cancelActiveHfDownload(id: string): HfQueueMutationResult {
  const current = ensureState();
  const job =
    current.queue.find((entry) => entry.id === id) ??
    current.history.find((entry) => entry.id === id);
  if (!job) {
    return { ok: false, status: 404, error: `no download job ${id}` };
  }
  if (job.status !== "running" || currentRun?.jobId !== job.id) {
    return {
      ok: false,
      status: 409,
      error: `download job ${id} is not running`,
    };
  }
  job.cancelRequested = true;
  job.message = "Canceling download.";
  persist();
  currentRun.controller.abort();
  return { ok: true, state: getHfDownloadQueueState() };
}

export function pauseHfDownloadJob(id: string): HfQueueMutationResult {
  const current = ensureState();
  const job = current.queue.find((entry) => entry.id === id);
  if (!job) {
    return { ok: false, status: 404, error: `no download job ${id}` };
  }
  if (job.status === "queued") {
    job.status = "paused";
    job.pauseReason = "manual";
    job.message = "Paused by user.";
    persist();
    return { ok: true, state: getHfDownloadQueueState() };
  }
  if (job.status === "running" && currentRun?.jobId === job.id) {
    if (job.cancelRequested) {
      return {
        ok: false,
        status: 409,
        error: `download job ${id} is being canceled`,
      };
    }
    if (!job.pauseRequested) {
      job.pauseRequested = true;
      job.message = "Pausing download.";
      persist();
      currentRun.controller.abort();
    }
    return { ok: true, state: getHfDownloadQueueState() };
  }
  return {
    ok: false,
    status: 409,
    error: `download job ${id} is not running or queued`,
  };
}

export function resumeHfDownloadJob(
  id: string,
  options?: { ignoreSlowEta?: boolean },
): HfQueueMutationResult {
  const current = ensureState();
  const job = current.queue.find((entry) => entry.id === id);
  if (!job) {
    return { ok: false, status: 404, error: `no download job ${id}` };
  }
  if (job.status !== "paused") {
    return {
      ok: false,
      status: 409,
      error: `download job ${id} is not paused`,
    };
  }
  if (options?.ignoreSlowEta) {
    job.slowEtaOverride = true;
  }
  job.status = "queued";
  job.pauseReason = null;
  job.message = "Queued.";
  job.error = null;
  persist();
  pump();
  return { ok: true, state: getHfDownloadQueueState() };
}

export function removeHfDownloadQueueJob(id: string): HfQueueMutationResult {
  const current = ensureState();
  const queuedIndex = current.queue.findIndex((entry) => entry.id === id);
  if (queuedIndex >= 0) {
    const job = current.queue[queuedIndex];
    if (job && job.status === "running") {
      return {
        ok: false,
        status: 409,
        error: `download job ${id} is running; cancel it first`,
      };
    }
    current.queue.splice(queuedIndex, 1);
    jobOptions.delete(id);
    persist();
    return { ok: true, state: getHfDownloadQueueState() };
  }
  const historyIndex = current.history.findIndex((entry) => entry.id === id);
  if (historyIndex >= 0) {
    current.history.splice(historyIndex, 1);
    persist();
    return { ok: true, state: getHfDownloadQueueState() };
  }
  return { ok: false, status: 404, error: `no download job ${id}` };
}

export function reorderHfDownloadQueue(
  ids: readonly string[],
): HfQueueMutationResult {
  const current = ensureState();
  const queued = current.queue.filter((entry) => entry.status === "queued");
  const queuedIds = new Set(queued.map((entry) => entry.id));
  const uniqueIds = new Set(ids);
  if (
    ids.length !== queued.length ||
    uniqueIds.size !== queued.length ||
    ![...uniqueIds].every((id) => queuedIds.has(id))
  ) {
    return {
      ok: false,
      status: 400,
      error: "ids must be exactly the currently queued job ids",
    };
  }
  const byId = new Map(queued.map((entry) => [entry.id, entry]));
  const retained = current.queue.filter((entry) => entry.status !== "queued");
  current.queue = [
    ...retained,
    ...ids.flatMap((id) => {
      const job = byId.get(id);
      return job ? [job] : [];
    }),
  ];
  persist();
  return { ok: true, state: getHfDownloadQueueState() };
}

export function skipHfDownloadFiles(
  id: string,
  paths: readonly string[],
): HfQueueMutationResult {
  const current = ensureState();
  const job = current.queue.find((entry) => entry.id === id);
  if (!job) {
    const finished = current.history.find((entry) => entry.id === id);
    if (finished) {
      return {
        ok: false,
        status: 409,
        error: `download job ${id} already finished`,
      };
    }
    return { ok: false, status: 404, error: `no download job ${id}` };
  }
  const known = new Set(job.files.map((file) => file.path));
  const targets = [...new Set(paths)];
  const unknown = targets.filter((path) => !known.has(path));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 404,
      error: `not in this download: ${unknown.slice(0, 5).join(", ")}`,
    };
  }
  if (job.status === "queued" || job.status === "paused") {
    const targetSet = new Set(targets);
    job.files = job.files.filter((file) => !targetSet.has(file.path));
    job.totalBytes = job.files.reduce((sum, file) => sum + file.size, 0);
    if (job.files.length === 0) {
      current.queue = current.queue.filter((entry) => entry.id !== job.id);
      jobOptions.delete(job.id);
    }
    persist();
    return { ok: true, state: getHfDownloadQueueState() };
  }
  for (const path of targets) {
    const file = job.files.find((entry) => entry.path === path);
    if (!file) {
      continue;
    }
    if (file.status === "pending") {
      userCanceledPaths.add(path);
      patchFile(job, path, { status: "canceled" });
    } else if (file.status === "downloading") {
      userCanceledPaths.add(path);
      fileAborts.get(path)?.();
    }
  }
  persist();
  return { ok: true, state: getHfDownloadQueueState() };
}

export function clearHfDownloadHistory(): HfDownloadQueueState {
  const current = ensureState();
  current.history = [];
  persist();
  return getHfDownloadQueueState();
}

export function adoptHfDownloadQueue(): {
  resumed: number;
  queued: number;
  history: number;
} {
  const current = ensureState();
  pump();
  return {
    resumed: current.resumedAtLoad,
    queued: current.queue.length,
    history: current.history.length,
  };
}

export function beginHfDownloadQueueShutdown(): void {
  shuttingDown = true;
}

export async function waitForHfDownloadQueueIdle(): Promise<void> {
  for (;;) {
    const run = currentRun;
    if (run) {
      await run.completion.catch(() => undefined);
      await new Promise((resolveDone) => setImmediate(resolveDone));
      continue;
    }
    const current = ensureState();
    if (
      shuttingDown ||
      !current.queue.some((entry) => entry.status === "queued")
    ) {
      return;
    }
    await new Promise((resolveDone) => setImmediate(resolveDone));
  }
}

export function setHfDownloadQueueFallbackOptionsForTests(
  options: HfDownloadQueueOptions | null,
): void {
  fallbackJobOptions = options;
}

export function reloadHfDownloadQueueFromStoreForTests(): void {
  state = null;
}

export function resetHfDownloadQueueForTests(): void {
  currentRun?.controller.abort();
  resetActiveJobs();
  currentRun = null;
  shuttingDown = false;
  currentConnections = null;
  currentTelemetry = null;
  slowEtaTrigger = null;
  fallbackJobOptions = null;
  jobOptions.clear();
  liveBytes.clear();
  pendingBaselinePaths.clear();
  userCanceledPaths.clear();
  fileAborts.clear();
  state = { queue: [], history: [], resumedAtLoad: 0 };
  persist();
  invalidateHfDownloadsCache();
}
