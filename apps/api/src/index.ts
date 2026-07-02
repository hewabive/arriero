import { serve } from "@hono/node-server";
import pino from "pino";

import { initArgumentDefaults } from "./arguments/defaults-repository.js";
import { pruneMissingArgumentCatalogs } from "./arguments/repository.js";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import {
  app,
  startApiProxyIdleMaintenanceLoop,
  startApiProxyRuntimeReconcileLoop,
} from "./http.js";
import { runMigrations } from "./migrations/index.js";
import { ensureConfigScaffold } from "./proxy/config-files.js";
import { apiProxyPendingResume } from "./proxy/pending-resume.js";
import { apiProxyStreamSessions } from "./proxy/stream-session.js";
import { collectApiProxyPipelineGraphWarnings } from "./proxy/pipeline-validation.js";
import {
  getApiProxyTarget,
  listApiProxyPipelines,
} from "./proxy/repository.js";
import { pruneMissingCachedModels } from "./models/cache-repository.js";
import { listInstances } from "./instances/repository.js";
import { reconcileProcessRuns } from "./process/reconcile.js";
import { pruneProcessRunHistory } from "./process/runs-repository.js";
import {
  ensureResourcePoolsScaffold,
  refreshAutoCapacities,
} from "./resources/repository.js";
import { initAppSettings } from "./settings/store.js";
import { supervisor } from "./process/supervisor.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

migrate();
ensureConfigScaffold();
const appliedMigrations = runMigrations();
initAppSettings();
initArgumentDefaults();
const seededResourcePools = ensureResourcePoolsScaffold();
const refreshedResourcePools = refreshAutoCapacities();
const prunedArgumentCatalogs = pruneMissingArgumentCatalogs();
const prunedModelCache = pruneMissingCachedModels();
const reconciliation = reconcileProcessRuns(listInstances());
const prunedProcessRuns = pruneProcessRunHistory();
const pendingResume = apiProxyPendingResume.adopt();
if (pendingResume.adopted > 0) {
  logger.info(
    { adopted: pendingResume.adopted },
    "pending stream sessions adopted for resume",
  );
  void pendingResume.verified.then(() => {
    logger.info(
      { remaining: apiProxyPendingResume.size() },
      "pending stream sessions verified against llama-server",
    );
  });
}

for (const warning of collectApiProxyPipelineGraphWarnings({
  pipelines: listApiProxyPipelines(),
  hasTarget: (id) => Boolean(getApiProxyTarget(id)),
})) {
  logger.warn(warning, "api proxy pipeline graph is invalid");
}

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    logger.info(
      {
        address: info.address,
        port: info.port,
        appliedMigrations,
        reconciliation,
        prunedProcessRuns,
        prunedArgumentCatalogs,
        prunedModelCache,
        seededResourcePools,
        refreshedResourcePools,
      },
      "llama-manager api listening",
    );
  },
);

const stopApiProxyIdleMaintenance = startApiProxyIdleMaintenanceLoop({
  onError: (error) =>
    logger.error({ error }, "api proxy idle maintenance pass failed"),
});

const stopApiProxyRuntimeReconcile = startApiProxyRuntimeReconcileLoop({
  onError: (error) =>
    logger.error({ error }, "api proxy runtime reconcile pass failed"),
});

type ForceClosableServer = typeof server & {
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};

function closeServer(timeoutMs = 1_500) {
  return new Promise<void>((resolveDone, reject) => {
    let settled = false;
    const forceTimer = setTimeout(
      () => {
        (server as ForceClosableServer).closeAllConnections?.();
      },
      Math.min(500, timeoutMs),
    );
    const timeout = setTimeout(() => {
      finish();
    }, timeoutMs);

    function finish(error?: Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolveDone();
    }

    server.close((error?: Error) => {
      finish(error);
    });
    (server as ForceClosableServer).closeIdleConnections?.();
  });
}

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) {
    logger.warn({ signal }, "shutdown already in progress");
    return;
  }

  shutdownStarted = true;
  logger.info({ signal }, "llama-manager api shutting down");

  try {
    const resumeSessions = apiProxyStreamSessions.beginPersist();
    const persisted = apiProxyPendingResume.persist(
      config.shutdown.stopManagedOnExit ? [] : resumeSessions,
    );
    if (persisted > 0) {
      logger.info(
        { persisted },
        "in-flight stream sessions persisted for resume",
      );
    }
    stopApiProxyIdleMaintenance();
    stopApiProxyRuntimeReconcile();
    await closeServer();
    logger.info("http server closed");

    if (config.shutdown.stopManagedOnExit) {
      const result = await supervisor.shutdownAll(config.shutdown.timeoutMs);
      logger.info(
        { result },
        "managed llama-server processes stopped during shutdown",
      );
    } else {
      logger.info(
        "managed llama-server shutdown disabled; processes will be reconciled as stale on next start",
      );
    }
  } catch (error) {
    process.exitCode = 1;
    logger.error({ error }, "shutdown failed");
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});

process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});
