import { updateAdapter } from "./adapter.js";
import type {
  UpdateJob,
  UpdateJobStatus,
  UpdateJobStep,
  UpdateJobStepName,
} from "./adapter.js";

const UPDATE_JOB_HISTORY_LIMIT = 10;
const updateJobs = new Map<string, UpdateJob>();

function cloneJob(job: UpdateJob): UpdateJob {
  return structuredClone(job);
}

function trimHistory() {
  if (updateJobs.size <= UPDATE_JOB_HISTORY_LIMIT) {
    return;
  }
  const removable = [...updateJobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const job of removable) {
    if (updateJobs.size <= UPDATE_JOB_HISTORY_LIMIT) {
      break;
    }
    updateJobs.delete(job.id);
  }
}

export function createUpdateJob(input: {
  steps: UpdateJobStep[];
  fromCommit: string | null;
  willRestart: boolean;
  startedAt: string;
  logPath: string;
}): UpdateJob {
  const job: UpdateJob = {
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
  };
  updateJobs.set(job.id, cloneJob(job));
  trimHistory();
  return cloneJob(job);
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
  const current = updateJobs.get(id);
  if (!current) {
    return null;
  }
  const next: UpdateJob = {
    ...current,
    status: input.status ?? current.status,
    steps: input.steps ?? current.steps,
    currentStep:
      input.currentStep === undefined ? current.currentStep : input.currentStep,
    toCommit: input.toCommit === undefined ? current.toCommit : input.toCommit,
    finishedAt:
      input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
    error: input.error === undefined ? current.error : input.error,
  };
  updateJobs.set(id, cloneJob(next));
  return cloneJob(next);
}

export function getUpdateJob(id: string): UpdateJob | null {
  const job = updateJobs.get(id);
  return job ? cloneJob(job) : null;
}

export function latestUpdateJob(): UpdateJob | null {
  const jobs = [...updateJobs.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  return jobs[0] ? cloneJob(jobs[0]) : null;
}
