import {
  MEMORY_ESTIMATOR_VERSION,
  type Instance,
  type InstanceHealthSummary,
  type InstanceMemoryLayout,
  type MemoryAssessmentSummary,
} from "@arriero/core";

import { getInstance } from "../instances/repository.js";
import { getAppVersion } from "../update/version.js";
import { canonicalJsonDigest as digest } from "../utils/canonical-json.js";
import type { MemoryEstimateResolution } from "../memory-estimate/service.js";
import {
  MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION,
  assessmentContextFromInstance,
  assessmentEngine,
  type AssessmentEngine,
} from "./engines.js";
import { measuredComparisonDeltas } from "./measured.js";
import {
  drawsDigest,
  parseStoredReceipt,
  type AnalyticalReceipt,
  type MeasuredReceipt,
  type MemoryAssessmentReceipt,
  type MemoryAssessmentValidation,
} from "./receipt.js";
import {
  bindMemoryAssessment as bindStoredAssessment,
  createMemoryAssessmentDraft as createStoredDraft,
  getMemoryAssessmentById,
  getMemoryAssessmentForInstance,
  updateMemoryAssessmentReceipt,
} from "./repository.js";

export { MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION };
export { captureMeasuredBaseline } from "./measured.js";

type EvaluationInput = {
  layout?: InstanceMemoryLayout;
  runId?: string | null;
};

function notAssessedSummary(engine: AssessmentEngine): MemoryAssessmentSummary {
  return {
    status: "not-assessed",
    reason: engine.notAssessedReason,
    reasons: [],
    recommendation: engine.notAssessedRecommendation,
    assessedAt: null,
    evidence: null,
    estimatorId: null,
    estimatorVersion: null,
    confidence: null,
    reservationStatus: "not-applied",
    validationSource: "none",
    deltas: [],
    baseline: null,
    reportAvailable: false,
  };
}

export function createMemoryAssessment(
  result: Extract<MemoryEstimateResolution, { ok: true }>,
): string | null {
  const context = result.context;
  const engine = assessmentEngine(context.kind);
  if (!engine?.estimatorId) {
    return null;
  }
  const createdAt = new Date().toISOString();
  const receipt: AnalyticalReceipt = {
    schemaVersion: 1,
    evidence: "analytical",
    estimatorId: engine.estimatorId,
    estimatorVersion: MEMORY_ESTIMATOR_VERSION,
    createdAt,
    fingerprint: engine.buildFingerprint(context),
    estimate: result.estimate,
    appliedDrawsDigest: null,
    validation: null,
  };
  return createStoredDraft(receipt).id;
}

export function bindMemoryAssessmentToInstance(
  assessmentId: string,
  instanceId: string,
): MemoryAssessmentSummary {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error("instance not found");
  const engine = assessmentEngine(instance.kind);
  if (!engine) {
    throw new Error(
      `memory assessments are not applicable to ${instance.kind} instances`,
    );
  }
  const stored = getMemoryAssessmentById(assessmentId);
  if (!stored) throw new Error("memory assessment not found");
  if (stored.instanceId && stored.instanceId !== instanceId) {
    throw new Error("memory assessment is already bound to another instance");
  }
  const receipt = parseStoredReceipt(stored.receipt);
  if (!receipt) throw new Error("memory assessment receipt is invalid");
  if (receipt.evidence !== "analytical") {
    throw new Error(
      "only analytical assessments can be bound; measured baselines are captured in place",
    );
  }
  const current = engine.buildFingerprint(
    assessmentContextFromInstance(instance),
  );
  if (current.digest !== receipt.fingerprint.digest) {
    throw new Error(
      "instance, binary, model files, or hardware changed after the estimate; run it again",
    );
  }
  const currentDrawsDigest = drawsDigest(instance.memory);
  const estimateDrawsDigest = drawsDigest(receipt.estimate.draws);
  const bound: AnalyticalReceipt = {
    ...receipt,
    appliedDrawsDigest:
      currentDrawsDigest === estimateDrawsDigest ? currentDrawsDigest : null,
  };
  bindStoredAssessment(assessmentId, instanceId, bound);
  return (
    evaluateInstanceMemoryAssessment(instance) ?? notAssessedSummary(engine)
  );
}

function analyticalReservationStatus(
  instance: Instance,
  receipt: AnalyticalReceipt,
): MemoryAssessmentSummary["reservationStatus"] {
  if (!receipt.appliedDrawsDigest) return "not-applied";
  return drawsDigest(instance.memory) === receipt.appliedDrawsDigest
    ? "applied"
    : "modified";
}

function measuredReservationStatus(
  instance: Instance,
  receipt: MeasuredReceipt,
): MemoryAssessmentSummary["reservationStatus"] {
  if (receipt.observation.draws.length === 0) return "not-applied";
  if (drawsDigest(instance.memory) === receipt.proposedDrawsDigest) {
    return "applied";
  }
  return instance.memory.length === 0 ? "not-applied" : "modified";
}

function exceedsTolerance(delta: {
  deltaBytes: number;
  toleranceBytes: number;
}): boolean {
  return Math.abs(delta.deltaBytes) > delta.toleranceBytes;
}

function deltaReasons(validation: MemoryAssessmentValidation): string[] {
  return validation.deltas
    .filter(exceedsTolerance)
    .map(
      (entry) =>
        `${entry.scope.toUpperCase()} differs by ${entry.deltaBytes} bytes (tolerance ${entry.toleranceBytes}).`,
    );
}

type SummaryContext<Receipt extends MemoryAssessmentReceipt> = {
  engine: AssessmentEngine;
  instance: Instance;
  storedId: string;
  receipt: Receipt;
  reasons: string[];
  layout: InstanceMemoryLayout | undefined;
  runId: string | null;
};

function analyticalSummary(
  input: SummaryContext<AnalyticalReceipt>,
): MemoryAssessmentSummary {
  const { engine, instance, receipt, reasons } = input;
  const base = {
    assessedAt: receipt.createdAt,
    evidence: "analytical" as const,
    estimatorId: receipt.estimatorId,
    estimatorVersion: receipt.estimatorVersion,
    confidence: receipt.estimate.confidence,
    reservationStatus: analyticalReservationStatus(instance, receipt),
    baseline: null,
    reportAvailable: true,
  };
  if (reasons.length > 0) {
    return {
      ...base,
      status: "update-required",
      reason: reasons[0] ?? "The memory assessment is stale.",
      reasons,
      recommendation: engine.updateRecommendation,
      validationSource: receipt.validation?.source ?? "none",
      deltas: receipt.validation?.deltas ?? [],
    };
  }

  const alreadyValidatedRun =
    receipt.validation?.runId != null &&
    receipt.validation.runId === input.runId;
  const validation =
    input.layout && !alreadyValidatedRun
      ? engine.validateAnalytical(receipt, input.layout, input.runId)
      : null;
  if (
    validation &&
    digest({ ...validation, observedAt: null }) !==
      digest({ ...receipt.validation, observedAt: null })
  ) {
    updateMemoryAssessmentReceipt(input.storedId, { ...receipt, validation });
  }
  const effective = validation ?? receipt.validation;
  const withValidation = {
    ...base,
    validationSource: effective?.source ?? ("none" as const),
    deltas: effective?.deltas ?? [],
  };
  if (effective?.verdict === "mismatch") {
    return {
      ...withValidation,
      status: "mismatch",
      reason: engine.wording.mismatch,
      reasons: deltaReasons(effective),
      recommendation: engine.updateRecommendation,
    };
  }
  if (effective?.verdict === "verified") {
    return {
      ...withValidation,
      status: "verified",
      reason: engine.wording.verified,
      reasons: [],
      recommendation: null,
    };
  }
  return {
    ...withValidation,
    status: "analytical",
    reason:
      effective?.verdict === "inconclusive"
        ? engine.wording.inconclusive
        : engine.wording.pending,
    reasons:
      receipt.estimate.confidence === "low"
        ? ["The estimator reported low confidence for this model layout."]
        : [],
    recommendation: null,
  };
}

function maybeValidateMeasured(
  receipt: MeasuredReceipt,
  layout: InstanceMemoryLayout | undefined,
  runId: string | null,
): MemoryAssessmentValidation | null {
  if (
    !layout ||
    layout.source !== "process-telemetry" ||
    layout.totalBytes <= 0
  ) {
    return null;
  }
  if (!runId || runId === receipt.observation.runId) return null;
  if (receipt.validation?.runId === runId) return null;
  const deltas = measuredComparisonDeltas(receipt.observation, {
    deviceBytes: layout.deviceBytes,
    hostBytes: layout.hostBytes,
    mmapBytes: layout.otherBytes,
  });
  const mismatch = deltas.some(exceedsTolerance);
  return {
    source: "process-telemetry",
    observedAt: new Date().toISOString(),
    runId,
    verdict: mismatch ? "mismatch" : "verified",
    deltas,
  };
}

function previousBaselineReasons(receipt: MeasuredReceipt): string[] {
  const previous = receipt.previousBaseline;
  if (!previous) return [];
  return previous.deltas
    .filter(exceedsTolerance)
    .map(
      (entry) =>
        `${entry.scope.toUpperCase()} changed by ${entry.deltaBytes} bytes versus the previous baseline captured ${previous.capturedAt}.`,
    );
}

function measuredSummary(
  input: SummaryContext<MeasuredReceipt>,
): MemoryAssessmentSummary {
  const { engine, instance, receipt, reasons } = input;
  const base = {
    assessedAt: receipt.createdAt,
    evidence: "measured" as const,
    estimatorId: null,
    estimatorVersion: null,
    confidence: null,
    reservationStatus: measuredReservationStatus(instance, receipt),
    baseline: {
      capturedAt: receipt.observation.capturedAt,
      deviceBytes: receipt.observation.deviceBytes,
      hostBytes: receipt.observation.hostBytes,
      mmapBytes: receipt.observation.mmapBytes,
      draws: receipt.observation.draws,
    },
    reportAvailable: true,
  };
  if (reasons.length > 0) {
    return {
      ...base,
      status: "update-required",
      reason: reasons[0] ?? "The measured baseline is stale.",
      reasons,
      recommendation: engine.updateRecommendation,
      validationSource: receipt.validation?.source ?? "none",
      deltas: receipt.validation?.deltas ?? [],
    };
  }

  const validation = maybeValidateMeasured(receipt, input.layout, input.runId);
  if (validation) {
    updateMemoryAssessmentReceipt(input.storedId, { ...receipt, validation });
  }
  const effective = validation ?? receipt.validation;
  const informational = [
    ...receipt.observation.notes,
    ...previousBaselineReasons(receipt),
  ];
  if (effective?.verdict === "mismatch") {
    return {
      ...base,
      status: "mismatch",
      reason: "Observed runtime memory differs from the measured baseline.",
      reasons: [...deltaReasons(effective), ...informational],
      recommendation: engine.updateRecommendation,
      validationSource: effective.source,
      deltas: effective.deltas,
    };
  }
  if (effective?.verdict === "verified") {
    return {
      ...base,
      status: "verified",
      reason: "Observed runtime memory matches the measured baseline.",
      reasons: informational,
      recommendation: null,
      validationSource: effective.source,
      deltas: effective.deltas,
    };
  }
  return {
    ...base,
    status: "measured",
    reason: "A measured baseline is recorded for this configuration.",
    reasons: informational,
    recommendation: null,
    validationSource: "none",
    deltas: [],
  };
}

export function evaluateInstanceMemoryAssessment(
  instance: Instance,
  input: EvaluationInput = {},
): MemoryAssessmentSummary | undefined {
  const engine = assessmentEngine(instance.kind);
  if (!engine) return undefined;
  const stored = getMemoryAssessmentForInstance(instance.name);
  if (!stored) return notAssessedSummary(engine);
  const receipt = parseStoredReceipt(stored.receipt);
  if (!receipt) {
    return {
      ...notAssessedSummary(engine),
      status: "update-required",
      reason:
        "The stored memory assessment cannot be read by this Arriero version.",
      reasons: ["The local assessment receipt is invalid or obsolete."],
      recommendation: engine.updateRecommendation,
      reportAvailable: true,
    };
  }
  const current = engine.buildFingerprint(
    assessmentContextFromInstance(instance),
  );
  const reasons = engine.driftReasons(receipt.fingerprint, current);
  if (receipt.evidence === "analytical") {
    if (receipt.estimatorId !== engine.estimatorId) {
      reasons.unshift("A different estimator produced this assessment.");
    } else if (receipt.estimatorVersion !== MEMORY_ESTIMATOR_VERSION) {
      reasons.unshift(
        "Arriero's memory estimator changed since this assessment.",
      );
    }
  }
  const context = {
    engine,
    instance,
    storedId: stored.id,
    reasons,
    layout: input.layout,
    runId: input.runId ?? null,
  };
  return receipt.evidence === "analytical"
    ? analyticalSummary({ ...context, receipt })
    : measuredSummary({ ...context, receipt });
}

function redactRecord<T>(record: Record<string, T>) {
  const sensitive = /(token|key|secret|password|auth|credential)/i;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitive.test(key) ? "[redacted]" : value,
    ]),
  );
}

export function buildMemoryAssessmentReport(
  instance: Instance,
  health: InstanceHealthSummary,
) {
  const engine = assessmentEngine(instance.kind);
  const stored = getMemoryAssessmentForInstance(instance.name);
  const receipt = stored
    ? (parseStoredReceipt(stored.receipt) ?? stored.receipt)
    : null;
  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    app: getAppVersion(),
    estimator: {
      id: engine?.estimatorId ?? null,
      version: MEMORY_ESTIMATOR_VERSION,
    },
    instance: {
      name: instance.name,
      kind: instance.kind,
      binaryPath: instance.binaryPath,
      binaryPathRefId: instance.binaryPathRefId,
      args: redactRecord(instance.args),
      positionalArgs: instance.positionalArgs ?? [],
      env: redactRecord(instance.env),
      engineConfig: instance.engineConfig ?? null,
      memory: instance.memory,
    },
    assessment: health.memoryAssessment ?? null,
    receipt,
    currentFingerprint: engine
      ? engine.buildFingerprint(assessmentContextFromInstance(instance))
      : null,
    runtime: health.runtime,
    configDrift: health.configDrift,
    memoryLayout: health.logSummary.memoryLayout,
  };
}
