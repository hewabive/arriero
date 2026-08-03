import { createJobStore } from "../jobs/store.js";
import { updateAdapter } from "./adapter.js";
import type {
  UpdateJob,
  UpdateJobStatus,
  UpdateJobStep,
  UpdateJobStepName,
} from "./adapter.js";

const UPDATE_JOB_HISTORY_LIMIT = 10;

export const updateJobs = createJobStore<UpdateJob>({
  historyLimit: UPDATE_JOB_HISTORY_LIMIT,
});

export function createUpdateJob(input: {
  steps: UpdateJobStep[];
  fromCommit: string | null;
  willRestart: boolean;
  startedAt: string;
  logPath: string;
}): UpdateJob {
  return updateJobs.insert({
    id: updateAdapter.newJobId(),
    status: "running",
    steps: input.steps,
    currentStep: null,
    fromCommit: input.fromCommit,
    toCommit: null,
    willRestart: input.willRestart,
    startedAt: input.startedAt,
    finishedAt: null,
    logPath: input.logPath,
    error: null,
  });
}

export function patchUpdateJob(
  id: string,
  input: Partial<{
    status: UpdateJobStatus;
    steps: UpdateJobStep[];
    currentStep: UpdateJobStepName | null;
    toCommit: string | null;
    finishedAt: string | null;
    error: string | null;
  }>,
): UpdateJob | null {
  return updateJobs.patch(id, input);
}

export function getUpdateJob(id: string): UpdateJob | null {
  return updateJobs.get(id);
}

export function latestUpdateJob(): UpdateJob | null {
  return updateJobs.list(1)[0] ?? null;
}
