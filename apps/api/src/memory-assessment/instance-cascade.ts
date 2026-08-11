import {
  clearMemoryAssessmentAutoNote,
  renameMemoryAssessmentAutoNote,
} from "./auto-note.js";
import {
  clearMemoryAssessmentAttempts,
  renameMemoryAssessmentAttempts,
} from "./auto-attempts.js";
import {
  deleteMemoryAssessmentForInstance,
  renameMemoryAssessmentInstance,
} from "./repository.js";

export function renameMemoryAssessmentState(from: string, to: string): void {
  renameMemoryAssessmentInstance(from, to);
  renameMemoryAssessmentAutoNote(from, to);
  renameMemoryAssessmentAttempts(from, to);
}

export function deleteMemoryAssessmentState(instanceId: string): void {
  deleteMemoryAssessmentForInstance(instanceId);
  clearMemoryAssessmentAutoNote(instanceId);
  clearMemoryAssessmentAttempts(instanceId);
}
