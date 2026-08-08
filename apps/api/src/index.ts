import { serve } from "@hono/node-server";

import { initArgumentDefaults } from "./arguments/defaults-repository.js";
import { pruneMissingArgumentCatalogs } from "./arguments/repository.js";
import { config } from "./config.js";
import { untrackMachineStateFiles } from "./config-git/machine-state.js";
import { normalizeConfigFiles } from "./config-normalize.js";
import { migrate } from "./db/index.js";
import { logger } from "./logger.js";
import {
  app,
  startApiProxyIdleMaintenanceLoop,
  startApiProxyRuntimeReconcileLoop,
} from "./http.js";
import { runMigrations } from "./migrations/index.js";
import { ensureConfigScaffold } from "./proxy/config-files.js";
import { apiProxyPendingResume } from "./proxy/pending-resume.js";
import { apiProxyStats } from "./proxy/stats.js";
import {
  pruneApiProxyTraceHistory,
  startApiProxyTraceRetentionLoop,
} from "./proxy/traces-repository.js";
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
import { augmentProcessPath } from "./system/path-repair.js";
import { sweepSourceCloneStaging } from "./sources/operations.js";
import { shutdownActiveJobs } from "./jobs/registry.js";
import { supervisor } from "./process/supervisor.js";
import { initializeEnvironments } from "./envs/service.js";
import { nvidiaTelemetry } from "./nvidia/telemetry.js";
import { systemMetricsRecorder } from "./system/metrics-history.js";
import {
  initSystemMetricsPersistence,
  startSystemMetricsRetentionLoop,
} from "./system/metrics-repository.js";

const repairedPathDirectories = augmentProcessPath();
if (repairedPathDirectories.length > 0) {
  logger.info(
    { directories: repairedPathDirectories },
    "appended well-known tool directories to PATH",
  );
}

migrate();
ensureConfigScaffold();
const appliedMigrations = runMigrations();
const normalizedConfigFiles = normalizeConfigFiles();
const untrackedMachineState = await untrackMachineStateFiles();
initAppSettings();
initArgumentDefaults();
const systemMetricsPersistence = initSystemMetricsPersistence(
  systemMetricsRecorder,
  {
    onError: (error) =>
      logger.error({ error }, "system metrics history write failed"),
  },
);
systemMetricsRecorder.start();
const seededResourcePools = ensureResourcePoolsScaffold();
const refreshedResourcePools = refreshAutoCapacities();
const environments = initializeEnvironments();
const sweptSourceCloneStaging = sweepSourceCloneStaging();
const prunedArgumentCatalogs = pruneMissingArgumentCatalogs();
const prunedModelCache = pruneMissingCachedModels();
const reconciliation = reconcileProcessRuns(listInstances());
const prunedProcessRuns = pruneProcessRunHistory();
const prunedTraceHistory = pruneApiProxyTraceHistory();
const seededStatsTraces = apiProxyStats.seedFromHistory();
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
        normalizedConfigFiles,
        untrackedMachineState,
        reconciliation,
        prunedProcessRuns,
        prunedTraceHistory,
        seededStatsTraces,
        systemMetricsPersistence,
        prunedArgumentCatalogs,
        prunedModelCache,
        seededResourcePools,
        refreshedResourcePools,
        environments,
        sweptSourceCloneStaging,
      },
      "arriero api listening",
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

const stopApiProxyTraceRetention = startApiProxyTraceRetentionLoop({
  onError: (error) =>
    logger.error({ error }, "api proxy trace retention prune failed"),
});

const stopSystemMetricsRetention = startSystemMetricsRetentionLoop({
  onError: (error) =>
    logger.error({ error }, "system metrics retention prune failed"),
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
  logger.info({ signal }, "arriero api shutting down");

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
    stopApiProxyTraceRetention();
    stopSystemMetricsRetention();
    systemMetricsRecorder.stop();
    await closeServer();
    logger.info("http server closed");
    const stoppedJobs = await shutdownActiveJobs(config.shutdown.timeoutMs);
    if (stoppedJobs > 0) {
      logger.info(
        { stopped: stoppedJobs },
        "background jobs stopped during shutdown",
      );
    }

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
    nvidiaTelemetry.close();
    process.exit(process.exitCode ?? 0);
  }
}

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});

process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});
