import {
  engineDescriptor,
  type Instance,
  type InstanceHealthSummary,
  type MemoryAssessmentDelta,
} from "@arriero/core";

import { latestProcessRun } from "../process/runs-repository.js";
import { contextFromInstance } from "../memory-estimate/service.js";
import {
  getRuntimeMemoryObservation,
  type RuntimeMemoryObservation,
} from "../process/runtime-memory.js";
import { listMemoryPools } from "../resources/repository.js";
import { readTailLines } from "../utils/log-tail.js";
import { compareStrings } from "../utils/sort.js";
import { assessmentEngine, telemetryToleranceBytes } from "./engines.js";
import {
  drawsDigest,
  parseStoredReceipt,
  type MeasuredObservation,
  type MeasuredReceipt,
} from "./receipt.js";
import {
  bindMemoryAssessment as bindStoredAssessment,
  createMemoryAssessmentDraft as createStoredDraft,
  getMemoryAssessmentForInstance,
} from "./repository.js";

const MEASURE_ATTEMPTS = 4;
const MEASURE_RETRY_DELAY_MS = 400;

type MeasuredTotals = {
  deviceBytes: number;
  hostBytes: number;
  mmapBytes: number;
};

export function measuredComparisonDeltas(
  baseline: MeasuredTotals,
  observed: MeasuredTotals,
): MemoryAssessmentDelta[] {
  const pairs = [
    {
      scope: "gpu" as const,
      expectedBytes: baseline.deviceBytes,
      observedBytes: observed.deviceBytes,
    },
    {
      scope: "host" as const,
      expectedBytes: baseline.hostBytes + baseline.mmapBytes,
      observedBytes: observed.hostBytes + observed.mmapBytes,
    },
  ].filter((entry) => entry.expectedBytes > 0 || entry.observedBytes > 0);
  return pairs.map((entry) => ({
    ...entry,
    deltaBytes: entry.observedBytes - entry.expectedBytes,
    toleranceBytes: telemetryToleranceBytes(entry.expectedBytes),
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observationTotalBytes(observation: RuntimeMemoryObservation): number {
  return (
    observation.anonBytes +
    observation.fileBytes +
    observation.deviceByIndex.reduce((sum, entry) => sum + entry.bytes, 0)
  );
}

function tailLines(logPath: string | null): string[] {
  if (!logPath) return [];
  try {
    return readTailLines(logPath, 1_000).lines;
  } catch {
    return [];
  }
}

export async function captureMeasuredBaseline(input: {
  instance: Instance;
  health: InstanceHealthSummary;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { instance, health } = input;
  const descriptor = engineDescriptor(instance.kind);
  const engine = assessmentEngine(instance.kind);
  if (!descriptor.assessment.measuredBaseline || !engine) {
    return {
      ok: false,
      reason: `measured baseline is not supported for ${instance.kind} instances`,
    };
  }
  if (health.runtime.status !== "running") {
    return { ok: false, reason: "instance is not running" };
  }
  if (!health.logSummary.ready && !health.llama.health.ok) {
    return { ok: false, reason: "instance has not reached readiness yet" };
  }
  if (health.configDrift) {
    return {
      ok: false,
      reason:
        "instance configuration changed since launch; restart the instance before capturing a baseline",
    };
  }

  const lines = tailLines(health.runtime.logPath);
  let best: RuntimeMemoryObservation | null = null;
  for (let attempt = 0; attempt < MEASURE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(MEASURE_RETRY_DELAY_MS);
    const observation = await getRuntimeMemoryObservation({
      runtime: health.runtime,
      lines,
      kind: instance.kind,
    });
    if (
      observation &&
      (best === null ||
        observationTotalBytes(observation) > observationTotalBytes(best))
    ) {
      best = observation;
    }
  }
  if (!best || observationTotalBytes(best) <= 0) {
    return {
      ok: false,
      reason:
        "no runtime memory telemetry is available for the instance processes",
    };
  }

  const pools = listMemoryPools();
  const draws: MeasuredObservation["draws"] = [];
  const notes: string[] = [];
  let deviceBytes = 0;
  for (const entry of best.deviceByIndex) {
    deviceBytes += entry.bytes;
    const pool = pools.find(
      (candidate) =>
        candidate.kind === "gpu" &&
        Number(candidate.deviceRef) === entry.deviceIndex,
    );
    if (pool) {
      draws.push({ poolId: pool.id, bytes: entry.bytes });
    } else {
      notes.push(
        `GPU device ${entry.deviceIndex} holds ${entry.bytes} bytes that map to no configured memory pool.`,
      );
    }
  }
  const hostBytes = best.anonBytes;
  const mmapBytes = best.fileBytes;
  const hostPools = pools.filter((pool) => pool.kind === "host");
  const hostPool = hostPools[0];
  if (hostBytes + mmapBytes > 0) {
    if (hostPools.length === 1 && hostPool) {
      draws.push({ poolId: hostPool.id, bytes: hostBytes + mmapBytes });
    } else {
      notes.push(
        "Host RAM could not be attributed to a single host memory pool; declare the host draw manually.",
      );
    }
  }
  draws.sort((left, right) => compareStrings(left.poolId, right.poolId));

  const capturedAt = new Date().toISOString();
  const runId = latestProcessRun(instance.name)?.id ?? null;
  const observation: MeasuredObservation = {
    capturedAt,
    runId,
    processIds: best.processIds,
    deviceBytes,
    hostBytes,
    mmapBytes,
    draws,
    notes,
  };

  const stored = getMemoryAssessmentForInstance(instance.name);
  const storedReceipt = stored ? parseStoredReceipt(stored.receipt) : null;
  const previousBaseline =
    storedReceipt?.evidence === "measured"
      ? {
          capturedAt: storedReceipt.observation.capturedAt,
          deltas: measuredComparisonDeltas(
            storedReceipt.observation,
            observation,
          ),
        }
      : null;

  const receipt: MeasuredReceipt = {
    schemaVersion: 1,
    evidence: "measured",
    baselineVersion: 1,
    createdAt: capturedAt,
    fingerprint: engine.buildFingerprint(contextFromInstance(instance)),
    observation,
    previousBaseline,
    proposedDrawsDigest: drawsDigest(draws),
    validation: null,
  };
  const draft = createStoredDraft(receipt);
  bindStoredAssessment(draft.id, instance.name, receipt);
  return { ok: true };
}
