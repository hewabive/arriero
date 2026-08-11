export type AutoEstimateOutcome = "bound" | "failed" | "stale";

type EstimateAttempt = { digest: string; outcome: AutoEstimateOutcome };
type MeasureAttempt = { digest: string; runId: string };

const estimateAttempts = new Map<string, EstimateAttempt>();
const measureAttempts = new Map<string, MeasureAttempt>();

export function getAutoEstimateAttempt(
  instanceId: string,
): EstimateAttempt | null {
  return estimateAttempts.get(instanceId) ?? null;
}

export function setAutoEstimateAttempt(
  instanceId: string,
  attempt: EstimateAttempt,
): void {
  estimateAttempts.set(instanceId, attempt);
}

export function getAutoMeasureAttempt(
  instanceId: string,
): MeasureAttempt | null {
  return measureAttempts.get(instanceId) ?? null;
}

export function setAutoMeasureAttempt(
  instanceId: string,
  attempt: MeasureAttempt,
): void {
  measureAttempts.set(instanceId, attempt);
}

export function renameMemoryAssessmentAttempts(from: string, to: string): void {
  const estimate = estimateAttempts.get(from);
  estimateAttempts.delete(from);
  if (estimate) {
    estimateAttempts.set(to, estimate);
  }
  const measure = measureAttempts.get(from);
  measureAttempts.delete(from);
  if (measure) {
    measureAttempts.set(to, measure);
  }
}

export function clearMemoryAssessmentAttempts(instanceId: string): void {
  estimateAttempts.delete(instanceId);
  measureAttempts.delete(instanceId);
}
