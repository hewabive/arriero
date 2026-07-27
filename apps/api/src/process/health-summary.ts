import {
  engineDescriptor,
  type Instance,
  type InstanceHealthActions,
  type InstanceHealthSummary,
  type InstanceHealthSummaryStatus,
  type NumaPlacement,
  type RuntimeState,
} from "@arriero/core";

import { engineProbe } from "./engine-probe.js";
import {
  hasLaunchSnapshotDrift,
  parseLaunchSnapshot,
} from "./launch-snapshot.js";
import {
  instanceCudaDevicesDisabled,
  summarizeInstanceLog,
} from "./log-summary.js";
import {
  validateInstancePreflight,
  validateInstanceStartPreflight,
} from "./preflight.js";
import { promptCacheTracker } from "./prompt-cache-tracker.js";
import { latestProcessRun, type ProcessRun } from "./runs-repository.js";
import {
  getInstanceNumaPlacement,
  getInstanceSwapBytes,
} from "./runtime-memory.js";
import { supervisor } from "./supervisor.js";

const SWAP_DEGRADED_THRESHOLD_BYTES = 64 * 1024 * 1024;

type HealthSummaryOptions = {
  peers?: Instance[] | undefined;
  checkStartAvailability?: boolean | undefined;
};

const runtimeStatuses = new Set<Instance["status"]>([
  "stopped",
  "starting",
  "running",
  "stopping",
  "exited",
  "stale",
  "error",
]);
const probeableStatuses = new Set<Instance["status"]>([
  "starting",
  "running",
  "stale",
]);

function nowIso() {
  return new Date().toISOString();
}

function isRuntimeStatus(
  value: string | null | undefined,
): value is Instance["status"] {
  return Boolean(value && runtimeStatuses.has(value as Instance["status"]));
}

function durableRuntime(
  instance: Instance,
  latestRun: ProcessRun | null,
): RuntimeState {
  const pid = latestRun?.pid ? Number(latestRun.pid) : null;
  const exitCode =
    latestRun?.exitCode === null || latestRun?.exitCode === undefined
      ? null
      : Number(latestRun.exitCode);

  return {
    instanceId: instance.name,
    pid: pid && Number.isFinite(pid) ? pid : null,
    status: isRuntimeStatus(latestRun?.status)
      ? latestRun.status
      : instance.status,
    startedAt: latestRun?.startedAt ?? null,
    stoppedAt: latestRun?.stoppedAt ?? null,
    exitCode: exitCode === null || Number.isFinite(exitCode) ? exitCode : null,
    logPath: latestRun?.logPath ?? null,
    rawLogPath: latestRun?.rawLogPath ?? null,
    adopted: latestRun?.adopted === "true",
  };
}

const driftCheckStatuses = new Set<Instance["status"]>([
  "starting",
  "running",
  "stopping",
  "stale",
]);

function detectConfigDrift(
  instance: Instance,
  runtime: RuntimeState,
  latestRun: ProcessRun | null,
): boolean {
  if (!driftCheckStatuses.has(runtime.status)) {
    return false;
  }
  const snapshot = parseLaunchSnapshot(latestRun?.launchSnapshot);
  if (!snapshot) {
    return false;
  }
  return hasLaunchSnapshotDrift(instance, snapshot);
}

function actionsFor(
  runtime: RuntimeState,
  preflightOk: boolean,
): InstanceHealthActions {
  const canStart =
    preflightOk && ["stopped", "exited", "error"].includes(runtime.status);
  const canStop = ["starting", "running", "stale"].includes(runtime.status);
  const canRestart =
    preflightOk &&
    ["starting", "running", "stale", "error"].includes(runtime.status);

  return {
    canStart,
    canStop,
    canRestart,
  };
}

export function deriveStatus(input: {
  runtime: RuntimeState;
  engine: { httpHealth: boolean; displayName: string };
  preflightOk: boolean;
  preflightErrors: number;
  preflightWarnings: number;
  healthOk: boolean;
  healthStatus: number | null;
  logReady: boolean;
  logErrors: number;
  logErrorTail?: string[];
  logWarnings: number;
  swapBytes: number | null;
  numaPlacement: NumaPlacement | null;
}): { status: InstanceHealthSummaryStatus; reason: string } {
  const legacyReadinessName =
    input.engine.displayName === "KTransformers (SGLang-KT)"
      ? input.engine.displayName
      : "llama-server";
  if (input.runtime.status === "stale") {
    if (input.healthOk) {
      return {
        status: "stale",
        reason: input.runtime.pid
          ? `Process pid=${input.runtime.pid} is unmanaged, but ${legacyReadinessName} health is OK.`
          : `Last run is unmanaged, but ${legacyReadinessName} health is OK.`,
      };
    }
    return {
      status: "stale",
      reason: input.runtime.pid
        ? `Process pid=${input.runtime.pid} is still alive, but it is not managed by this API process.`
        : "Last run was marked stale and is not managed by this API process.",
    };
  }

  if (input.runtime.status === "stopping") {
    return {
      status: "stopping",
      reason: "Process is stopping.",
    };
  }

  if (input.runtime.status === "error") {
    const tail = (input.logErrorTail ?? []).slice(-3);
    if (tail.length > 0) {
      return {
        status: "error",
        reason: ["Process is in error state. Recent log errors:", ...tail].join(
          "\n",
        ),
      };
    }
    return {
      status: "error",
      reason: "Runtime is in error state.",
    };
  }

  if (
    !input.preflightOk &&
    ["stopped", "exited"].includes(input.runtime.status)
  ) {
    return {
      status: "invalid",
      reason: `${input.preflightErrors} blocking preflight issue${input.preflightErrors === 1 ? "" : "s"} must be fixed before start.`,
    };
  }

  if (input.runtime.status === "stopped" || input.runtime.status === "exited") {
    if (input.runtime.exitCode !== null && input.runtime.exitCode !== 0) {
      return {
        status: "error",
        reason: `Last process exited with code ${input.runtime.exitCode}.`,
      };
    }

    return {
      status: "stopped",
      reason: "Instance is not running.",
    };
  }

  if (input.runtime.status === "starting") {
    return {
      status: "starting",
      reason: `Process was started and the API is waiting for ${legacyReadinessName} readiness.`,
    };
  }

  if (!input.preflightOk) {
    return {
      status: "degraded",
      reason: `${input.preflightErrors} preflight issue${input.preflightErrors === 1 ? "" : "s"} detected while the process is running.`,
    };
  }

  if (!input.engine.httpHealth) {
    const swappedOut =
      input.swapBytes !== null &&
      input.swapBytes >= SWAP_DEGRADED_THRESHOLD_BYTES;
    if (input.logErrors > 0 || swappedOut) {
      const issues = [
        input.logErrors > 0
          ? `${input.logErrors} log error${input.logErrors === 1 ? "" : "s"}`
          : null,
        swappedOut
          ? `${Math.round((input.swapBytes ?? 0) / (1024 * 1024))} MiB of process memory in swap`
          : null,
      ].filter(Boolean);
      return {
        status: "degraded",
        reason: `${input.engine.displayName} process is running, but ${issues.join(", ")} detected.`,
      };
    }
    return {
      status: "ready",
      reason: input.healthOk
        ? `${input.engine.displayName} is listening for the orchestrator.`
        : `${input.engine.displayName} process is running; the readiness probe was not answered (it may be busy serving the orchestrator or firewalled from the manager).`,
    };
  }

  if (input.healthOk) {
    const swappedOut =
      input.swapBytes !== null &&
      input.swapBytes >= SWAP_DEGRADED_THRESHOLD_BYTES;
    const numaSkewed =
      input.numaPlacement !== null && !input.numaPlacement.even;
    if (
      input.logErrors > 0 ||
      input.logWarnings > 0 ||
      input.preflightWarnings > 0 ||
      swappedOut ||
      numaSkewed
    ) {
      const issues = [
        input.logErrors > 0
          ? `${input.logErrors} log error${input.logErrors === 1 ? "" : "s"}`
          : null,
        input.logWarnings > 0
          ? `${input.logWarnings} log warning${input.logWarnings === 1 ? "" : "s"}`
          : null,
        input.preflightWarnings > 0
          ? `${input.preflightWarnings} preflight warning${input.preflightWarnings === 1 ? "" : "s"}`
          : null,
        swappedOut
          ? `${Math.round((input.swapBytes ?? 0) / (1024 * 1024))} MiB of process memory in swap`
          : null,
        numaSkewed
          ? `uneven NUMA interleave placement (${input.numaPlacement?.maxNodeSharePct}% of memory on one node, ideal ~${input.numaPlacement?.idealSharePct}%)`
          : null,
      ].filter(Boolean);
      return {
        status: "degraded",
        reason: `HTTP health is OK, but ${issues.join(", ")} detected.`,
      };
    }

    return {
      status: "ready",
      reason: `${input.engine.displayName} health endpoint is OK.`,
    };
  }

  if (input.healthStatus === 503 || input.logReady) {
    return {
      status: "loading",
      reason:
        input.healthStatus === 503
          ? `${input.engine.displayName} is reachable but still loading.`
          : "Logs look ready, but HTTP health is not OK yet.",
    };
  }

  if (input.logErrors > 0) {
    return {
      status: "error",
      reason: "Recent logs contain errors and HTTP health is not OK.",
    };
  }

  return {
    status: "loading",
    reason: `Process is running, but ${input.engine.displayName} health endpoint is not ready yet.`,
  };
}

export async function getInstanceHealthSummary(
  instance: Instance,
  options: HealthSummaryOptions = {},
): Promise<InstanceHealthSummary> {
  const latestRun = latestProcessRun(instance.name);
  const runtime =
    supervisor.getState(instance.name) ?? durableRuntime(instance, latestRun);
  const shouldCheckStartAvailability =
    (options.checkStartAvailability ?? true) &&
    ["stopped", "exited", "error"].includes(runtime.status);
  const preflight = shouldCheckStartAvailability
    ? await validateInstanceStartPreflight(instance, {
        peers: options.peers,
      })
    : validateInstancePreflight(instance, {
        peers: options.peers,
      });
  const descriptor = engineDescriptor(instance.kind);
  const probeRunner = engineProbe(instance.kind);
  const shouldProbe = probeableStatuses.has(runtime.status);
  const probe = !shouldProbe
    ? Promise.resolve(probeRunner.offline(instance, "Instance is not running."))
    : probeRunner.probe(instance);
  const [llama, logSummary, swapBytes] = await Promise.all([
    probe,
    summarizeInstanceLog({
      instanceId: instance.name,
      kind: instance.kind,
      runtime,
      cudaDevicesDisabled: instanceCudaDevicesDisabled(instance),
    }),
    shouldProbe
      ? getInstanceSwapBytes(runtime, instance.kind)
      : Promise.resolve(null),
  ]);
  const preflightErrors = preflight.issues.filter(
    (issue) => issue.level === "error",
  ).length;
  const preflightWarnings = preflight.issues.length - preflightErrors;
  const numaPlacement =
    instance.numa?.mode === "interleave" &&
    runtime.status === "running" &&
    llama.health.ok
      ? await getInstanceNumaPlacement({
          instance,
          runtime,
          runId: latestRun?.id ?? null,
        })
      : null;
  const derived = deriveStatus({
    runtime,
    engine: {
      httpHealth: descriptor.probe.httpHealth,
      displayName: descriptor.displayName,
    },
    preflightOk: preflight.ok,
    preflightErrors,
    preflightWarnings,
    healthOk: llama.health.ok,
    healthStatus: llama.health.status,
    logReady: logSummary.ready,
    logErrors: logSummary.errors.length,
    logErrorTail: logSummary.errors,
    logWarnings: logSummary.warnings.length,
    swapBytes,
    numaPlacement,
  });

  return {
    instanceId: instance.name,
    status: derived.status,
    reason: derived.reason,
    actions: actionsFor(runtime, preflight.ok),
    runtime,
    preflight,
    llama,
    logSummary,
    promptCache: promptCacheTracker.get(instance.name),
    configDrift: detectConfigDrift(instance, runtime, latestRun),
    swapBytes,
    numaPlacement,
    checkedAt: nowIso(),
  };
}
