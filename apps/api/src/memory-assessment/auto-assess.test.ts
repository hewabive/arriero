import type {
  Instance,
  MemoryAssessmentEvidence,
  MemoryAssessmentStatus,
  MemoryAssessmentSummary,
} from "@arriero/core";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { decideAutoAssessment } from "./auto-assess.js";
import {
  clearMemoryAssessmentAutoNote,
  renameMemoryAssessmentAutoNote,
  setMemoryAssessmentAutoNote,
} from "./auto-note.js";
import { evaluateInstanceMemoryAssessment } from "./service.js";

function summary(
  status: MemoryAssessmentStatus,
  evidence: MemoryAssessmentEvidence | null = null,
): MemoryAssessmentSummary {
  return {
    status,
    reason: "",
    reasons: [],
    recommendation: null,
    assessedAt: null,
    evidence,
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

function instance(name: string): Instance {
  return {
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPath: "/bin/sh",
    binaryPathRefId: "test-binary",
    cwd: tmpdir(),
    args: {},
    env: {},
    memory: [],
    status: "stopped",
    pid: null,
  };
}

const capable = {
  hasAnalyticalEstimator: true,
  supportsMeasuredBaseline: true,
};

test("unassessed instances estimate first and fall back to measurement", () => {
  assert.equal(
    decideAutoAssessment({ summary: undefined, ...capable }),
    "none",
  );
  assert.equal(
    decideAutoAssessment({ summary: summary("not-assessed"), ...capable }),
    "estimate",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("not-assessed"),
      hasAnalyticalEstimator: false,
      supportsMeasuredBaseline: true,
    }),
    "measure",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("not-assessed"),
      hasAnalyticalEstimator: false,
      supportsMeasuredBaseline: false,
    }),
    "none",
  );
});

test("stale receipts refresh within their own evidence type", () => {
  assert.equal(
    decideAutoAssessment({
      summary: summary("update-required", "analytical"),
      ...capable,
    }),
    "estimate",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("update-required", "analytical"),
      hasAnalyticalEstimator: false,
      supportsMeasuredBaseline: true,
    }),
    "none",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("update-required", "measured"),
      ...capable,
    }),
    "measure",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("update-required", "measured"),
      hasAnalyticalEstimator: true,
      supportsMeasuredBaseline: false,
    }),
    "none",
  );
});

test("an unreadable receipt is treated as unassessed", () => {
  assert.equal(
    decideAutoAssessment({ summary: summary("update-required"), ...capable }),
    "estimate",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("update-required"),
      hasAnalyticalEstimator: false,
      supportsMeasuredBaseline: true,
    }),
    "measure",
  );
});

test("settled and mismatching assessments are never touched", () => {
  assert.equal(
    decideAutoAssessment({
      summary: summary("analytical", "analytical"),
      ...capable,
    }),
    "none",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("measured", "measured"),
      ...capable,
    }),
    "none",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("verified", "analytical"),
      ...capable,
    }),
    "none",
  );
  assert.equal(
    decideAutoAssessment({
      summary: summary("mismatch", "measured"),
      ...capable,
    }),
    "none",
  );
});

test("the last automatic failure surfaces on the not-assessed summary", () => {
  const name = `auto-note-${Date.now()}`;
  const renamed = `${name}-renamed`;
  const subject = instance(name);
  setMemoryAssessmentAutoNote(name, "estimate", "No --model is configured.");

  const enriched = evaluateInstanceMemoryAssessment(subject);
  assert.equal(enriched?.status, "not-assessed");
  assert.deepEqual(enriched?.reasons, [
    "Automatic analytical estimate failed: No --model is configured.",
  ]);

  renameMemoryAssessmentAutoNote(name, renamed);
  assert.deepEqual(evaluateInstanceMemoryAssessment(subject)?.reasons, []);
  const followed = evaluateInstanceMemoryAssessment(instance(renamed));
  assert.equal(followed?.reasons.length, 1);

  clearMemoryAssessmentAutoNote(renamed);
  assert.deepEqual(
    evaluateInstanceMemoryAssessment(instance(renamed))?.reasons,
    [],
  );
});
