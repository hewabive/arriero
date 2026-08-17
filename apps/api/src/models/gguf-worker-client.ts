import type { GgufTensorTable } from "@arriero/core";
import { Worker } from "node:worker_threads";

import { logger } from "../logger.js";
import { traceBlockingSection } from "../system/event-loop.js";
import type {
  GgufWorkerOp,
  GgufWorkerRequest,
  GgufWorkerResponse,
} from "./gguf-worker.js";
import {
  readGgufFacts,
  readGgufModelTensorTable,
  readGgufParameterCount,
  type GgufRawFacts,
} from "./gguf.js";
import {
  readSafetensorsFacts,
  type SafetensorsReadResult,
} from "./safetensors.js";

const IDLE_SHUTDOWN_MS = 30_000;

class GgufWorkerFailure extends Error {}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
let idleTimer: NodeJS.Timeout | null = null;
const pending = new Map<number, PendingRequest>();

function failPending(message: string) {
  const failure = new GgufWorkerFailure(message);
  for (const request of pending.values()) {
    request.reject(failure);
  }
  pending.clear();
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size === 0) {
      const current = worker;
      worker = null;
      void current?.terminate();
    }
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

function settle(response: GgufWorkerResponse) {
  const request = pending.get(response.id);
  if (!request) {
    return;
  }
  pending.delete(response.id);
  if (response.error !== undefined) {
    request.reject(new Error(response.error));
  } else {
    request.resolve(response.data);
  }
  if (pending.size === 0) {
    worker?.unref();
    scheduleIdleShutdown();
  }
}

function startWorker(): Worker | null {
  try {
    const created = new Worker(new URL("./gguf-worker.js", import.meta.url));
    created.on("message", settle);
    created.on("error", (error) => {
      logger.error({ err: error }, "gguf worker crashed");
      if (worker === created) {
        worker = null;
      }
      failPending((error as Error).message);
    });
    created.on("exit", (code) => {
      if (worker === created) {
        worker = null;
      }
      if (pending.size > 0) {
        failPending(`gguf worker exited with code ${code}`);
      }
    });
    created.unref();
    return created;
  } catch (error) {
    logger.error(
      { err: error },
      "gguf worker could not be started; parsing GGUF files in-process",
    );
    return null;
  }
}

function send<T>(target: Worker, op: GgufWorkerOp, path: string): Promise<T> {
  const id = nextRequestId;
  nextRequestId += 1;
  clearIdleTimer();
  target.ref();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as PendingRequest["resolve"], reject });
    const request: GgufWorkerRequest = { id, op, path };
    target.postMessage(request);
  });
}

async function runOffThread<T>(
  op: GgufWorkerOp,
  path: string,
  inProcess: () => T,
): Promise<T> {
  const runInProcess = () => traceBlockingSection(`models:${op}`, inProcess);
  if (workerUnavailable) {
    return runInProcess();
  }
  const target = worker ?? startWorker();
  if (!target) {
    workerUnavailable = true;
    return runInProcess();
  }
  worker = target;
  try {
    return await send<T>(target, op, path);
  } catch (error) {
    if (error instanceof GgufWorkerFailure) {
      workerUnavailable = true;
      logger.warn(
        { err: error, path },
        "gguf worker unavailable; falling back to in-process parsing",
      );
      return runInProcess();
    }
    throw error;
  }
}

export function readGgufFactsOffThread(path: string): Promise<GgufRawFacts> {
  return runOffThread("facts", path, () => readGgufFacts(path));
}

export function readGgufParameterCountOffThread(path: string): Promise<number> {
  return runOffThread("parameter-count", path, () =>
    readGgufParameterCount(path),
  );
}

export function readGgufModelTensorTableOffThread(
  path: string,
): Promise<GgufTensorTable> {
  return runOffThread("tensor-table", path, () =>
    readGgufModelTensorTable(path),
  );
}

export function readSafetensorsFactsOffThread(
  path: string,
): Promise<SafetensorsReadResult> {
  return runOffThread("safetensors-facts", path, () =>
    readSafetensorsFacts(path),
  );
}

export async function stopGgufWorker(): Promise<void> {
  clearIdleTimer();
  const current = worker;
  worker = null;
  if (current) {
    await current.terminate();
  }
}
