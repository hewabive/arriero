import type { ModelScanResult, ModelScanState } from "@arriero/core";

import { logger } from "../logger.js";
import {
  getModelScanSettings,
  pruneMissingCachedModels,
} from "./cache-repository.js";
import { listModelScanRoots } from "./roots.js";
import { scanModels, scanModelsFromCache } from "./scanner.js";

function idleState(): ModelScanState {
  return {
    status: "idle",
    done: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

let state: ModelScanState = idleState();
let running: Promise<void> | null = null;
let pendingRefresh = false;
let lastCache = { hits: 0, misses: 0 };

async function runScanPass(refresh: boolean): Promise<void> {
  state = {
    status: "scanning",
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  try {
    const settings = getModelScanSettings();
    const pass = await scanModels({
      roots: listModelScanRoots(),
      maxDepth: settings.maxDepth,
      refresh,
      onProgress: (progress) => {
        state = { ...state, done: progress.done, total: progress.total };
      },
    });
    pruneMissingCachedModels();
    lastCache = pass.cache;
    state = { ...state, status: "idle", finishedAt: new Date().toISOString() };
  } catch (error) {
    logger.error({ err: error }, "model scan failed");
    state = {
      ...state,
      status: "idle",
      finishedAt: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

export function startModelScan(input?: {
  refresh?: boolean | undefined;
}): ModelScanState {
  if (running) {
    if (input?.refresh) {
      pendingRefresh = true;
    }
    return state;
  }

  const run = async () => {
    await runScanPass(Boolean(input?.refresh));
    while (pendingRefresh) {
      pendingRefresh = false;
      await runScanPass(true);
    }
  };

  running = run()
    .catch((error: unknown) => {
      logger.error({ err: error }, "model scan runner failed");
    })
    .finally(() => {
      running = null;
    });

  return state;
}

export function getModelScanView(): ModelScanResult {
  const settings = getModelScanSettings();
  const pass = scanModelsFromCache({
    roots: listModelScanRoots(),
    maxDepth: settings.maxDepth,
  });
  return {
    roots: pass.roots,
    models: pass.models,
    cache: lastCache,
    scan: state,
  };
}
