export type MemoryAssessmentAutoNote = {
  action: "estimate" | "measure";
  reason: string;
  at: string;
};

const notes = new Map<string, MemoryAssessmentAutoNote>();

export function setMemoryAssessmentAutoNote(
  instanceId: string,
  action: MemoryAssessmentAutoNote["action"],
  reason: string,
): void {
  notes.set(instanceId, { action, reason, at: new Date().toISOString() });
}

export function clearMemoryAssessmentAutoNote(instanceId: string): void {
  notes.delete(instanceId);
}

export function getMemoryAssessmentAutoNote(
  instanceId: string,
): MemoryAssessmentAutoNote | null {
  return notes.get(instanceId) ?? null;
}

export function renameMemoryAssessmentAutoNote(from: string, to: string): void {
  const note = notes.get(from);
  notes.delete(from);
  if (note) {
    notes.set(to, note);
  }
}
