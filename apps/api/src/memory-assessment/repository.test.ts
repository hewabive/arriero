import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindMemoryAssessment,
  createMemoryAssessmentDraft,
  deleteMemoryAssessmentForInstance,
  getMemoryAssessmentById,
  getMemoryAssessmentForInstance,
  renameMemoryAssessmentInstance,
} from "./repository.js";

test("assessment binding is replaceable, idempotent, renameable, and local", () => {
  const instanceA = `assessment-repository-${Date.now()}-a`;
  const instanceB = `${instanceA}-b`;
  const first = createMemoryAssessmentDraft({ revision: 1 });
  bindMemoryAssessment(first.id, instanceA, { revision: 1 });
  bindMemoryAssessment(first.id, instanceA, { revision: 2 });
  assert.deepEqual(getMemoryAssessmentForInstance(instanceA)?.receipt, {
    revision: 2,
  });

  const replacement = createMemoryAssessmentDraft({ revision: 3 });
  bindMemoryAssessment(replacement.id, instanceA, { revision: 3 });
  assert.equal(getMemoryAssessmentById(first.id), null);
  assert.equal(getMemoryAssessmentForInstance(instanceA)?.id, replacement.id);

  renameMemoryAssessmentInstance(instanceA, instanceB);
  assert.equal(getMemoryAssessmentForInstance(instanceA), null);
  assert.equal(getMemoryAssessmentForInstance(instanceB)?.id, replacement.id);

  deleteMemoryAssessmentForInstance(instanceB);
  assert.equal(getMemoryAssessmentForInstance(instanceB), null);
});
