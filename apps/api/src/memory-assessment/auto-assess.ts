import {
  engineDescriptor,
  type Instance,
  type MemoryAssessmentSummary,
} from "@arriero/core";

import { config } from "../config.js";
import { listInstances } from "../instances/repository.js";
import { logger } from "../logger.js";
import {
  contextFromInstance,
  estimateMemory,
} from "../memory-estimate/service.js";
import { getInstanceHealthSummary } from "../process/health-summary.js";
import { latestProcessRun } from "../process/runs-repository.js";
import {
  clearMemoryAssessmentAutoNote,
  setMemoryAssessmentAutoNote,
} from "./auto-note.js";
import { assessmentEngine, type AssessmentEngine } from "./engines.js";
import { captureMeasuredBaseline } from "./measured.js";
import type { MemoryAssessmentFingerprint } from "./receipt.js";
import {
  bindMemoryAssessmentToInstance,
  createMemoryAssessment,
  evaluateInstanceMemoryAssessment,
} from "./service.js";

export type MemoryAssessmentAutoAction = "none" | "estimate" | "measure";

type MemoryAssessmentAutoPassResult = {
  estimated: number;
  measured: number;
  failed: number;
};

type EstimateOutcome = "bound" | "failed" | "stale";

const estimateAttempts = new Map<
  string,
  { digest: string; outcome: EstimateOutcome }
>();
const measureAttempts = new Map<string, { digest: string; runId: string }>();

function isUnassessed(summary: MemoryAssessmentSummary | undefined): boolean {
  return (
    summary?.status === "not-assessed" ||
    (summary?.status === "update-required" && summary.evidence === null)
  );
}

export function decideAutoAssessment(input: {
  summary: MemoryAssessmentSummary | undefined;
  hasAnalyticalEstimator: boolean;
  supportsMeasuredBaseline: boolean;
}): MemoryAssessmentAutoAction {
  const { summary } = input;
  if (!summary) return "none";
  if (isUnassessed(summary)) {
    if (input.hasAnalyticalEstimator) return "estimate";
    return input.supportsMeasuredBaseline ? "measure" : "none";
  }
  if (summary.status !== "update-required") return "none";
  if (summary.evidence === "analytical") {
    return input.hasAnalyticalEstimator ? "estimate" : "none";
  }
  return input.supportsMeasuredBaseline ? "measure" : "none";
}

function runAnalyticalAttempt(
  instance: Instance,
  fingerprint: MemoryAssessmentFingerprint,
  engine: AssessmentEngine,
  pass: MemoryAssessmentAutoPassResult,
): EstimateOutcome {
  const staleReason = engine.driftReasons(fingerprint, fingerprint)[0];
  if (staleReason) {
    pass.failed += 1;
    setMemoryAssessmentAutoNote(instance.name, "estimate", staleReason);
    return "stale";
  }
  const estimated = estimateMemory({ instanceId: instance.name });
  if (!estimated.ok) {
    pass.failed += 1;
    setMemoryAssessmentAutoNote(instance.name, "estimate", estimated.reason);
    return "failed";
  }
  const assessmentId = createMemoryAssessment(estimated);
  if (!assessmentId) {
    pass.failed += 1;
    setMemoryAssessmentAutoNote(
      instance.name,
      "estimate",
      `${instance.kind} has no analytical estimator`,
    );
    return "failed";
  }
  try {
    bindMemoryAssessmentToInstance(assessmentId, instance.name);
  } catch (error) {
    pass.failed += 1;
    setMemoryAssessmentAutoNote(
      instance.name,
      "estimate",
      (error as Error).message,
    );
    return "failed";
  }
  clearMemoryAssessmentAutoNote(instance.name);
  pass.estimated += 1;
  logger.info(
    { instance: instance.name },
    "memory assessment: analytical estimate auto-bound",
  );
  return "bound";
}

function attemptAnalytical(
  instance: Instance,
  engine: AssessmentEngine,
  pass: MemoryAssessmentAutoPassResult,
): EstimateOutcome {
  const fingerprint = engine.buildFingerprint(contextFromInstance(instance));
  const memo = estimateAttempts.get(instance.name);
  if (memo && memo.digest === fingerprint.digest) {
    return memo.outcome;
  }
  const outcome = runAnalyticalAttempt(instance, fingerprint, engine, pass);
  estimateAttempts.set(instance.name, {
    digest: fingerprint.digest,
    outcome,
  });
  return outcome;
}

async function attemptMeasured(
  instance: Instance,
  peers: Instance[],
  engine: AssessmentEngine,
  pass: MemoryAssessmentAutoPassResult,
): Promise<void> {
  if (instance.status !== "running") return;
  const runId = latestProcessRun(instance.name)?.id;
  if (!runId) return;
  const fingerprint = engine.buildFingerprint(contextFromInstance(instance));
  const memo = measureAttempts.get(instance.name);
  if (memo && memo.runId === runId && memo.digest === fingerprint.digest) {
    return;
  }
  const staleReason = engine.driftReasons(fingerprint, fingerprint)[0];
  if (staleReason) {
    measureAttempts.set(instance.name, {
      digest: fingerprint.digest,
      runId,
    });
    pass.failed += 1;
    setMemoryAssessmentAutoNote(instance.name, "measure", staleReason);
    return;
  }
  const health = await getInstanceHealthSummary(instance, { peers });
  if (
    health.runtime.status !== "running" ||
    !health.logSummary.ready ||
    health.configDrift
  ) {
    return;
  }
  measureAttempts.set(instance.name, { digest: fingerprint.digest, runId });
  const captured = await captureMeasuredBaseline({ instance, health });
  if (!captured.ok) {
    pass.failed += 1;
    setMemoryAssessmentAutoNote(instance.name, "measure", captured.reason);
    return;
  }
  clearMemoryAssessmentAutoNote(instance.name);
  pass.measured += 1;
  logger.info(
    { instance: instance.name },
    "memory assessment: measured baseline auto-captured",
  );
}

async function autoAssessInstance(
  instance: Instance,
  peers: Instance[],
  pass: MemoryAssessmentAutoPassResult,
): Promise<void> {
  const engine = assessmentEngine(instance.kind);
  if (!engine) return;
  const summary = evaluateInstanceMemoryAssessment(instance);
  const descriptor = engineDescriptor(instance.kind);
  const action = decideAutoAssessment({
    summary,
    hasAnalyticalEstimator: engine.analytical !== null,
    supportsMeasuredBaseline: descriptor.assessment.measuredBaseline,
  });
  if (action === "none") return;
  if (action === "estimate") {
    const outcome = attemptAnalytical(instance, engine, pass);
    if (
      outcome === "failed" &&
      isUnassessed(summary) &&
      descriptor.assessment.measuredBaseline
    ) {
      await attemptMeasured(instance, peers, engine, pass);
    }
    return;
  }
  await attemptMeasured(instance, peers, engine, pass);
}

async function runMemoryAssessmentAutoPass(): Promise<MemoryAssessmentAutoPassResult> {
  const pass: MemoryAssessmentAutoPassResult = {
    estimated: 0,
    measured: 0,
    failed: 0,
  };
  const instances = listInstances();
  for (const instance of instances) {
    try {
      await autoAssessInstance(instance, instances, pass);
    } catch (error) {
      pass.failed += 1;
      logger.error(
        { error, instance: instance.name },
        "memory assessment auto pass failed for an instance",
      );
    }
  }
  return pass;
}

export function startMemoryAssessmentAutoLoop(options?: {
  intervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): () => void {
  const intervalMs =
    options?.intervalMs ?? config.memoryAssessment.autoIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined;
  }

  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    void runMemoryAssessmentAutoPass()
      .catch((error) => options?.onError?.(error))
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
