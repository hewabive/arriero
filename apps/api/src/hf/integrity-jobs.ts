import type { HfIntegrityJob } from "@arriero/core";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { registerActiveJob } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { errorMessage } from "../utils/error-message.js";
import { newId } from "../utils/id.js";
import {
  checkHfDownloadIntegrity,
  resolveIdleHfDownload,
  HfDownloadBusyError,
} from "./downloads.js";
import { HfDownloadRequestError } from "./paths.js";
import { hfManifestPath, readHfManifest } from "./manifest.js";

type IntegrityJob = {
  state: HfIntegrityJob;
  controller: AbortController;
  manifestSignature: string;
  manifestStamp: string | null;
};

const jobs = new Map<string, IntegrityJob>();

function manifestStamp(dir: string): string | null {
  try {
    const info = statSync(hfManifestPath(dir), {
      bigint: true,
      throwIfNoEntry: false,
    });
    return info ? `${info.ino}:${info.size}:${info.mtimeNs}` : null;
  } catch (error) {
    logger.debug({ err: error, dir }, "hf manifest stat failed; rereading it");
    return null;
  }
}

function manifestSignature(dir: string): string {
  return JSON.stringify(readHfManifest(dir));
}

export function getHfIntegrityJob(dir: string): HfIntegrityJob | null {
  const job = jobs.get(resolve(dir));
  if (!job) return null;
  if (job.state.result) {
    const stamp = manifestStamp(job.state.dir);
    if (stamp === null || stamp !== job.manifestStamp) {
      if (job.manifestSignature !== manifestSignature(job.state.dir))
        return { ...job.state, result: null };
      job.manifestStamp = stamp;
    }
  }
  return job.state;
}

export function startHfIntegrityJob(dir: string): HfIntegrityJob {
  const existing = getHfIntegrityJob(dir);
  if (existing?.status === "running") return existing;
  const { resolved, manifest } = resolveIdleHfDownload(dir);
  if (jobs.size >= 20) {
    const removable = [...jobs].find(
      ([, job]) => job.state.status !== "running",
    );
    if (removable) jobs.delete(removable[0]);
    else throw new HfDownloadBusyError("Too many integrity checks are running");
  }
  const controller = new AbortController();
  const state: HfIntegrityJob = {
    id: newId(),
    dir: resolved,
    status: "running",
    completedFiles: 0,
    totalFiles: manifest.files.length,
    completedBytes: 0,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    verification: null,
    result: null,
    error: null,
  };
  const job: IntegrityJob = {
    state,
    controller,
    manifestSignature: JSON.stringify(manifest),
    manifestStamp: manifestStamp(resolved),
  };
  jobs.set(resolved, job);
  const completion = checkHfDownloadIntegrity(resolved, {
    signal: controller.signal,
    onProgress: (progress) => {
      state.verification = progress;
    },
    onFile: (file) => {
      state.completedFiles++;
      state.completedBytes += file.expectedSize;
    },
    onPersisted: () => {
      job.manifestStamp = manifestStamp(resolved);
      job.manifestSignature = manifestSignature(resolved);
    },
  })
    .then((result) => {
      state.result = result;
      state.status = "succeeded";
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) state.status = "canceled";
      else {
        state.status = "failed";
        state.error = errorMessage(error);
        logger.warn({ err: error, dir: resolved }, "integrity check failed");
      }
    })
    .finally(() => {
      state.verification = null;
    });
  registerActiveJob({
    domain: "hf-integrity",
    entityId: state.id,
    jobId: state.id,
    cancel: () => controller.abort(),
    completion,
  });
  return state;
}

export function cancelHfIntegrityJob(id: string): HfIntegrityJob {
  const job = [...jobs.values()].find((entry) => entry.state.id === id);
  if (!job) throw new HfDownloadRequestError("Integrity check is unavailable");
  if (job.state.status === "running") job.controller.abort();
  return job.state;
}
