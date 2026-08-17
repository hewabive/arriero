import type {
  HfDownloadFile,
  HfDownloadFileStatus,
  HfDownloadJob,
  HfDownloadStart,
  HfLfsInfo,
} from "@arriero/core";
import { createHash, type Hash } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  getActiveJob,
  registerActiveJob,
  resetActiveJobs,
} from "../jobs/registry.js";
import { createLatestJobStore } from "../jobs/store.js";
import { logger } from "../logger.js";
import { startModelScan } from "../models/scan-runner.js";
import { newId } from "../utils/id.js";
import {
  fetchHfPathsInfo,
  fetchHfRepoInfo,
  hfErrorFromResponse,
  hfRequestHeaders,
  hfResolveUrl,
  HfHubError,
  type HfClientOptions,
} from "./client.js";
import {
  HF_DOWNLOAD_JOB_DOMAIN,
  invalidateHfDownloadsCache,
} from "./downloads.js";
import { clearHfUpdateCheck, runHfUpdateChecks } from "./update-check.js";
import {
  readHfManifest,
  upsertHfManifestFile,
  type HfManifestFile,
} from "./manifest.js";
import {
  defaultHfDestDir,
  freeBytesForDir,
  HfDownloadRequestError,
  resolveWithin,
  sanitizeRepoRelativePath,
  splitHfRepoId,
} from "./paths.js";

const HEADROOM_BYTES = 256 * 1024 * 1024;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export class HfDownloadConflictError extends Error {}

export type HfDownloadRunnerOptions = {
  fetchImpl?: typeof fetch | undefined;
  token?: string | null | undefined;
  freeBytes?: ((dir: string) => Promise<number | null>) | undefined;
};

type PlannedFile = {
  path: string;
  size: number;
  oid: string;
  lfs: HfLfsInfo | null;
  lastCommitId: string | null;
  lastCommitDate: string | null;
  finalPath: string;
  partPath: string;
};

const latestJobs = createLatestJobStore<HfDownloadJob>();
const jobKeys = new Set<string>();
const liveProgress = new Map<string, { path: string; bytes: number }>();

function nowIso(): string {
  return new Date().toISOString();
}

function formatGib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

function withLiveProgress(job: HfDownloadJob | null): HfDownloadJob | null {
  if (!job || job.status !== "running") {
    return job;
  }
  const live = liveProgress.get(job.repoId);
  if (!live) {
    return job;
  }
  return {
    ...job,
    downloadedBytes: job.downloadedBytes + live.bytes,
    currentPath: live.path,
    files: job.files.map((file) =>
      file.path === live.path
        ? { ...file, status: "downloading", downloadedBytes: live.bytes }
        : file,
    ),
  };
}

function patchFile(
  repoId: string,
  path: string,
  patch: Partial<HfDownloadFile>,
): void {
  const current = latestJobs.get(repoId);
  if (!current) {
    return;
  }
  latestJobs.patch(repoId, {
    files: current.files.map((file) =>
      file.path === path ? { ...file, ...patch, path: file.path } : file,
    ),
  });
}

function createContentHash(file: PlannedFile): Hash {
  if (file.lfs) {
    return createHash("sha256");
  }
  const hash = createHash("sha1");
  hash.update(`blob ${file.size}\0`);
  return hash;
}

function expectedHex(file: PlannedFile): string {
  return file.lfs ? file.lfs.oid : file.oid;
}

async function feedFileToHash(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
}

async function hashLocalFile(file: PlannedFile, path: string): Promise<string> {
  const hash = createContentHash(file);
  await feedFileToHash(path, hash);
  return hash.digest("hex");
}

function manifestEntryMatches(
  entry: HfManifestFile | null,
  file: PlannedFile,
): boolean {
  if (!entry || entry.size !== file.size) {
    return false;
  }
  return entry.lfsOid !== null && file.lfs !== null
    ? entry.lfsOid === file.lfs.oid
    : entry.oid === file.oid;
}

type DownloadFileContext = {
  url: string;
  file: PlannedFile;
  signal: AbortSignal;
  clientOptions: HfClientOptions;
  manifestEntry: HfManifestFile | null;
  onBytes: (bytes: number) => void;
};

async function attemptDownload(
  ctx: DownloadFileContext,
  fromScratch: boolean,
): Promise<"downloaded" | "range-not-satisfiable"> {
  const { file, signal, clientOptions } = ctx;
  let offset = 0;
  if (existsSync(file.partPath)) {
    const partSize = statSync(file.partPath).size;
    if (!fromScratch && partSize > 0 && partSize < file.size) {
      offset = partSize;
    } else if (partSize !== 0) {
      truncateSync(file.partPath, 0);
    }
  }
  const headers: Record<string, string> = {
    ...hfRequestHeaders(clientOptions),
  };
  if (offset > 0) {
    headers.range = `bytes=${offset}-`;
  }
  const fetchImpl = clientOptions.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(ctx.url, {
      headers,
      signal,
      redirect: "follow",
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new HfHubError(
      "network",
      null,
      `download failed: ${(error as Error).message}`,
    );
  }
  if (response.status === 416) {
    if (existsSync(file.partPath)) {
      truncateSync(file.partPath, 0);
    }
    return "range-not-satisfiable";
  }
  if (!response.ok) {
    throw await hfErrorFromResponse(response);
  }
  if (offset > 0 && response.status !== 206) {
    truncateSync(file.partPath, 0);
    offset = 0;
  }
  if (!response.body) {
    throw new HfHubError(
      "upstream",
      response.status,
      `empty response body for ${file.path}`,
    );
  }
  const hash = createContentHash(file);
  if (offset > 0) {
    await feedFileToHash(file.partPath, hash);
  }
  let received = offset;
  ctx.onBytes(received);
  const out = createWriteStream(file.partPath, {
    flags: offset > 0 ? "a" : "w",
  });
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      ctx.onBytes(received);
      if (!out.write(buffer)) {
        await once(out, "drain");
      }
    }
    await new Promise<void>((resolveDone, reject) => {
      out.on("error", reject);
      out.end(() => resolveDone());
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
  if (received !== file.size) {
    throw new Error(
      `incomplete download of ${file.path}: got ${received} of ${file.size} bytes`,
    );
  }
  const hex = hash.digest("hex");
  if (hex !== expectedHex(file)) {
    rmSync(file.partPath, { force: true });
    throw new Error(
      `checksum mismatch for ${file.path}: expected ${expectedHex(file)}, got ${hex}`,
    );
  }
  renameSync(file.partPath, file.finalPath);
  return "downloaded";
}

async function downloadOneFile(
  ctx: DownloadFileContext,
): Promise<"succeeded" | "skipped"> {
  const { file } = ctx;
  if (
    existsSync(file.finalPath) &&
    statSync(file.finalPath).size === file.size
  ) {
    if (manifestEntryMatches(ctx.manifestEntry, file)) {
      return "skipped";
    }
    const hex = await hashLocalFile(file, file.finalPath);
    if (hex === expectedHex(file)) {
      return "skipped";
    }
  }
  mkdirSync(dirname(file.finalPath), { recursive: true });
  const first = await attemptDownload(ctx, false);
  if (first === "downloaded") {
    return "succeeded";
  }
  const second = await attemptDownload(ctx, true);
  if (second === "downloaded") {
    return "succeeded";
  }
  throw new Error(
    `could not download ${file.path}: server rejected the range request twice`,
  );
}

type DownloadJobContext = {
  repoId: string;
  destDir: string;
  sha: string;
  planned: PlannedFile[];
  signal: AbortSignal;
  clientOptions: HfClientOptions;
};

function finalizeJob(
  repoId: string,
  input: { aborted: boolean; failedCount: number; fatalError: string | null },
): void {
  const current = latestJobs.get(repoId);
  if (!current || current.status !== "running") {
    return;
  }
  const files = current.files.map((file) =>
    file.status === "pending" || file.status === "downloading"
      ? { ...file, status: "canceled" as HfDownloadFileStatus }
      : file,
  );
  const status = input.aborted
    ? "canceled"
    : input.fatalError || input.failedCount > 0
      ? "failed"
      : "succeeded";
  const error = input.aborted
    ? "canceled by user"
    : (input.fatalError ??
      (input.failedCount > 0
        ? `${input.failedCount} of ${files.length} files failed`
        : null));
  const completed = files.filter(
    (file) => file.status === "succeeded" || file.status === "skipped",
  ).length;
  latestJobs.patch(repoId, {
    files,
    status,
    error,
    message:
      status === "succeeded"
        ? `Downloaded ${completed} of ${files.length} files.`
        : status === "canceled"
          ? "Canceled by user."
          : error,
    finishedAt: nowIso(),
    currentPath: null,
  });
}

async function runDownloadJob(ctx: DownloadJobContext): Promise<void> {
  const { repoId, destDir, sha, planned, signal, clientOptions } = ctx;
  const existingManifest = readHfManifest(destDir);
  const manifestEntries = new Map(
    existingManifest?.files.map((file) => [file.path, file]) ?? [],
  );
  let completedBytes = 0;
  let failedCount = 0;
  let fatalError: string | null = null;
  let downloadedGguf = false;
  try {
    for (const file of planned) {
      if (signal.aborted || fatalError) {
        break;
      }
      patchFile(repoId, file.path, { status: "downloading" });
      latestJobs.patch(repoId, {
        currentPath: file.path,
        message: `Downloading ${file.path}`,
      });
      liveProgress.set(repoId, { path: file.path, bytes: 0 });
      try {
        const outcome = await downloadOneFile({
          url: hfResolveUrl(repoId, sha, file.path),
          file,
          signal,
          clientOptions,
          manifestEntry: manifestEntries.get(file.path) ?? null,
          onBytes: (bytes) => {
            const live = liveProgress.get(repoId);
            if (live && live.path === file.path) {
              live.bytes = Math.min(bytes, file.size);
            }
          },
        });
        completedBytes += file.size;
        upsertHfManifestFile(
          destDir,
          { repoId, revision: sha },
          {
            path: file.path,
            size: file.size,
            oid: file.oid,
            lfsOid: file.lfs?.oid ?? null,
            lastCommitId: file.lastCommitId,
            lastCommitDate: file.lastCommitDate,
          },
        );
        if (
          outcome === "succeeded" &&
          file.path.toLowerCase().endsWith(".gguf")
        ) {
          downloadedGguf = true;
        }
        patchFile(repoId, file.path, {
          status: outcome,
          downloadedBytes: file.size,
          error: null,
        });
        latestJobs.patch(repoId, {
          downloadedBytes: completedBytes,
          currentPath: null,
        });
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        const message = (error as Error).message;
        if (
          error instanceof HfHubError &&
          (error.kind === "unauthorized" ||
            error.kind === "gated" ||
            error.kind === "rate-limited")
        ) {
          fatalError = message;
        } else {
          failedCount += 1;
        }
        patchFile(repoId, file.path, { status: "failed", error: message });
        logger.warn(
          { repoId, path: file.path, err: error },
          "hf file download failed",
        );
      } finally {
        liveProgress.delete(repoId);
      }
    }
  } finally {
    liveProgress.delete(repoId);
    finalizeJob(repoId, { aborted: signal.aborted, failedCount, fatalError });
    invalidateHfDownloadsCache();
    clearHfUpdateCheck(destDir);
    if (latestJobs.get(repoId)?.status === "succeeded") {
      try {
        await runHfUpdateChecks([destDir], clientOptions);
      } catch (error) {
        logger.warn(
          { repoId, destDir, err: error },
          "post-download update check failed",
        );
      }
    }
    if (downloadedGguf) {
      startModelScan({ refresh: true });
    }
  }
}

export async function startHfDownload(
  input: HfDownloadStart,
  options?: HfDownloadRunnerOptions,
): Promise<HfDownloadJob> {
  const repoId = input.repoId;
  splitHfRepoId(repoId);
  if (getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, repoId)) {
    throw new HfDownloadConflictError(
      `a download for ${repoId} is already running`,
    );
  }
  const relPaths = [...new Set(input.paths.map(sanitizeRepoRelativePath))];
  const destDir = resolve(input.destDir ?? defaultHfDestDir(repoId));
  const clientOptions: HfClientOptions = {};
  if (options?.fetchImpl) {
    clientOptions.fetchImpl = options.fetchImpl;
  }
  if (options && options.token !== undefined) {
    clientOptions.token = options.token;
  }
  const revisionInput = input.revision ?? "main";
  const sha = COMMIT_SHA_PATTERN.test(revisionInput)
    ? revisionInput.toLowerCase()
    : (await fetchHfRepoInfo(repoId, revisionInput, clientOptions)).sha;
  const upstream = await fetchHfPathsInfo(
    repoId,
    sha,
    relPaths,
    true,
    clientOptions,
  );
  const planned: PlannedFile[] = [];
  const missing: string[] = [];
  for (const path of relPaths) {
    const info = upstream.get(path);
    if (!info) {
      missing.push(path);
      continue;
    }
    const finalPath = resolveWithin(destDir, path);
    planned.push({
      path,
      size: info.size,
      oid: info.oid,
      lfs: info.lfs,
      lastCommitId: info.lastCommitId,
      lastCommitDate: info.lastCommitDate,
      finalPath,
      partPath: `${finalPath}.part`,
    });
  }
  if (missing.length > 0) {
    throw new HfDownloadRequestError(
      `paths not found in ${repoId}@${sha.slice(0, 12)}: ${missing
        .slice(0, 5)
        .join(", ")}${missing.length > 5 ? "…" : ""}`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  const totalBytes = planned.reduce((sum, file) => sum + file.size, 0);
  const presentBytes = planned.reduce((sum, file) => {
    if (
      existsSync(file.finalPath) &&
      statSync(file.finalPath).size === file.size
    ) {
      return sum + file.size;
    }
    if (existsSync(file.partPath)) {
      return sum + Math.min(statSync(file.partPath).size, file.size);
    }
    return sum;
  }, 0);
  const freeBytes = await (options?.freeBytes ?? freeBytesForDir)(destDir);
  const requiredBytes = totalBytes - presentBytes + HEADROOM_BYTES;
  if (freeBytes !== null && freeBytes < requiredBytes) {
    throw new HfDownloadConflictError(
      `not enough free space in ${destDir}: need ${formatGib(requiredBytes)}, have ${formatGib(freeBytes)}`,
    );
  }
  const job: HfDownloadJob = {
    id: newId(),
    repoId,
    revision: sha,
    destDir,
    status: "running",
    message: "Preparing download.",
    startedAt: nowIso(),
    finishedAt: null,
    cancelRequested: false,
    error: null,
    totalBytes,
    downloadedBytes: 0,
    currentPath: null,
    files: planned.map((file) => ({
      path: file.path,
      size: file.size,
      status: "pending",
      downloadedBytes: 0,
      error: null,
    })),
  };
  latestJobs.start(repoId, job);
  jobKeys.add(repoId);
  const controller = new AbortController();
  const completion = runDownloadJob({
    repoId,
    destDir,
    sha,
    planned,
    signal: controller.signal,
    clientOptions,
  }).catch((error: unknown) => {
    logger.error({ repoId, err: error }, "hf download job crashed");
    const current = latestJobs.get(repoId);
    if (current && current.status === "running") {
      latestJobs.patch(repoId, {
        status: "failed",
        error: (error as Error).message,
        finishedAt: nowIso(),
      });
    }
  });
  registerActiveJob({
    domain: HF_DOWNLOAD_JOB_DOMAIN,
    entityId: repoId,
    jobId: job.id,
    cancel: () => controller.abort(),
    completion,
  });
  return job;
}

export function getHfDownloadJob(repoId: string): HfDownloadJob | null {
  return withLiveProgress(latestJobs.get(repoId));
}

export function listHfDownloadJobs(): HfDownloadJob[] {
  const jobs: HfDownloadJob[] = [];
  for (const key of jobKeys) {
    const job = withLiveProgress(latestJobs.get(key));
    if (job) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cancelHfDownload(repoId: string): HfDownloadJob | null {
  const active = getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, repoId);
  const job = latestJobs.get(repoId);
  if (!active || !job || job.status !== "running") {
    return null;
  }
  active.cancel();
  return withLiveProgress(
    latestJobs.patch(repoId, {
      cancelRequested: true,
      message: "Canceling download.",
    }),
  );
}

export function resetHfDownloadJobsForTests(): void {
  for (const key of jobKeys) {
    getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, key)?.cancel();
  }
  resetActiveJobs();
  latestJobs.clear();
  jobKeys.clear();
  liveProgress.clear();
  invalidateHfDownloadsCache();
}
