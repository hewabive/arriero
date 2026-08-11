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
import { startAsyncIntervalLoop } from "../utils/interval-loop.js";
import {
  getAutoEstimateAttempt,
  getAutoMeasureAttempt,
  setAutoEstimateAttempt,
  setAutoMeasureAttempt,
  type AutoEstimateOutcome,
} from "./auto-attempts.js";
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

type MemoryAssessmentAutoAction = "none" | "estimate" | "measure";

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
): AutoEstimateOutcome {
  const fail = (
    reason: string,
    outcome: AutoEstimateOutcome = "failed",
  ): AutoEstimateOutcome => {
    setMemoryAssessmentAutoNote(instance.name, "estimate", reason);
    return outcome;
  };
  const staleReason = engine.driftReasons(fingerprint, fingerprint)[0];
  if (staleReason) {
    return fail(staleReason, "stale");
  }
  const estimated = estimateMemory({ instanceId: instance.name });
  if (!estimated.ok) {
    return fail(estimated.reason);
  }
  const assessmentId = createMemoryAssessment(estimated);
  if (!assessmentId) {
    return fail(`${instance.kind} has no analytical estimator`);
  }
  try {
    bindMemoryAssessmentToInstance(assessmentId, instance.name);
  } catch (error) {
    return fail((error as Error).message);
  }
  clearMemoryAssessmentAutoNote(instance.name);
  logger.info(
    { instance: instance.name },
    "memory assessment: analytical estimate auto-bound",
  );
  return "bound";
}

function attemptAnalytical(
  instance: Instance,
  engine: AssessmentEngine,
): AutoEstimateOutcome {
  const fingerprint = engine.buildFingerprint(contextFromInstance(instance));
  const memo = getAutoEstimateAttempt(instance.name);
  if (memo && memo.digest === fingerprint.digest) {
    return memo.outcome;
  }
  const outcome = runAnalyticalAttempt(instance, fingerprint, engine);
  setAutoEstimateAttempt(instance.name, {
    digest: fingerprint.digest,
    outcome,
  });
  return outcome;
}

async function attemptMeasured(
  instance: Instance,
  peers: Instance[],
  engine: AssessmentEngine,
): Promise<void> {
  if (instance.status !== "running") return;
  const runId = latestProcessRun(instance.name)?.id;
  if (!runId) return;
  const fingerprint = engine.buildFingerprint(contextFromInstance(instance));
  const memo = getAutoMeasureAttempt(instance.name);
  if (memo && memo.runId === runId && memo.digest === fingerprint.digest) {
    return;
  }
  const staleReason = engine.driftReasons(fingerprint, fingerprint)[0];
  if (staleReason) {
    setAutoMeasureAttempt(instance.name, {
      digest: fingerprint.digest,
      runId,
    });
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
  setAutoMeasureAttempt(instance.name, {
    digest: fingerprint.digest,
    runId,
  });
  const captured = await captureMeasuredBaseline({ instance, health });
  if (!captured.ok) {
    setMemoryAssessmentAutoNote(instance.name, "measure", captured.reason);
    return;
  }
  clearMemoryAssessmentAutoNote(instance.name);
  logger.info(
    { instance: instance.name },
    "memory assessment: measured baseline auto-captured",
  );
}

async function autoAssessInstance(
  instance: Instance,
  peers: Instance[],
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
    const outcome = attemptAnalytical(instance, engine);
    if (
      outcome === "failed" &&
      isUnassessed(summary) &&
      descriptor.assessment.measuredBaseline
    ) {
      await attemptMeasured(instance, peers, engine);
    }
    return;
  }
  await attemptMeasured(instance, peers, engine);
}

async function runMemoryAssessmentAutoPass(): Promise<void> {
  const instances = listInstances();
  for (const instance of instances) {
    try {
      await autoAssessInstance(instance, instances);
    } catch (error) {
      logger.error(
        { error, instance: instance.name },
        "memory assessment auto pass failed for an instance",
      );
    }
  }
}

export function startMemoryAssessmentAutoLoop(options?: {
  onError?: ((error: unknown) => void) | undefined;
}): () => void {
  return startAsyncIntervalLoop(runMemoryAssessmentAutoPass, {
    intervalMs: config.memoryAssessment.autoIntervalMs,
    onError: options?.onError,
  });
}
