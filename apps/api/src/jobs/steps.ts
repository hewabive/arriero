import type { BackgroundJobBase, JobStore } from "./store.js";

export type JobStepBase = {
  name: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
};

export type SteppedJob<S extends JobStepBase> = BackgroundJobBase & {
  steps: S[];
  currentStep: S["name"] | null;
};

export function patchSteps<S extends JobStepBase>(
  steps: readonly S[],
  name: S["name"],
  patch: Partial<Omit<S, "name">>,
): S[] {
  return steps.map((step) =>
    step.name === name ? { ...step, ...patch } : step,
  );
}

export function markJobStep<S extends JobStepBase, J extends SteppedJob<S>>(
  store: JobStore<J>,
  jobId: string,
  name: S["name"],
  patch: Partial<Omit<S, "name">>,
): J {
  const current = store.get(jobId);
  if (!current) {
    throw new Error(`job not found: ${jobId}`);
  }
  const updated = store.patch(jobId, {
    steps: patchSteps<S>(current.steps, name, patch),
    currentStep: patch.status === "running" ? name : current.currentStep,
  } as Partial<J>);
  if (!updated) {
    throw new Error(`job not found: ${jobId}`);
  }
  return updated;
}
