import {
  SourceRepositoryOperationJobSchema,
  type SourceRepositoryClone,
  type SourceRepositoryOperationJob,
  type SourceRepositoryOperationKind,
  type SourceRepositoryOperationPhase,
} from "@arriero/core";

import { redactGitOutput } from "../git/process.js";
import {
  getActiveJob,
  listActiveJobs,
  registerActiveJob,
  resetActiveJobs,
} from "../jobs/registry.js";
import { createLatestJobStore } from "../jobs/store.js";
import { newId } from "../utils/id.js";
import {
  assertSourceContentCanChange,
  cloneSourceRepository,
  pullSourceRepository,
  type SourceRepositoryOperationRuntime,
} from "./operations.js";
import { assertSourceRepositoryOperationIdle } from "./state.js";

const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_LENGTH = 2_000;
const MAX_OUTPUT_LENGTH = 32_000;

const SOURCE_JOB_DOMAIN = "source";

const latestJobs = createLatestJobStore<SourceRepositoryOperationJob>();

function nowIso() {
  return new Date().toISOString();
}

function updateJob(
  sourceId: string,
  input: Partial<SourceRepositoryOperationJob>,
): SourceRepositoryOperationJob | null {
  return latestJobs.patch(sourceId, input);
}

function cleanLogLine(value: string): string {
  return redactGitOutput(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_LOG_LINE_LENGTH);
}

function appendLogLine(sourceId: string, value: string) {
  const line = cleanLogLine(value);
  if (!line) return;
  const current = latestJobs.get(sourceId);
  if (!current) return;
  updateJob(sourceId, {
    logLines: [...current.logLines, line].slice(-MAX_LOG_LINES),
  });
}

const PHASE_PROGRESS: Record<
  SourceRepositoryOperationPhase,
  { base: number; span: number }
> = {
  starting: { base: 1, span: 0 },
  updating: { base: 1, span: 0 },
  receiving: { base: 5, span: 65 },
  resolving: { base: 70, span: 20 },
  "checking-out": { base: 90, span: 7 },
  validating: { base: 98, span: 0 },
  publishing: { base: 99, span: 0 },
  complete: { base: 100, span: 0 },
};

function phaseProgress(
  phase: SourceRepositoryOperationPhase,
  stagePercent: number,
): number {
  const { base, span } = PHASE_PROGRESS[phase];
  const percent = Math.max(0, Math.min(100, stagePercent));
  return Math.round(base + (span * percent) / 100);
}

export function parseSourceGitProgress(line: string): {
  phase: SourceRepositoryOperationPhase;
  progress: number;
  message: string;
} | null {
  const match =
    /(Receiving objects|Resolving deltas|Updating files|Checking out files):\s*(\d+)%/i.exec(
      line,
    );
  if (!match) return null;
  const label = match[1]?.toLowerCase() ?? "";
  const phase: SourceRepositoryOperationPhase = label.startsWith("receiving")
    ? "receiving"
    : label.startsWith("resolving")
      ? "resolving"
      : "checking-out";
  return {
    phase,
    progress: phaseProgress(phase, Number(match[2])),
    message: cleanLogLine(line),
  };
}

function createReporter(
  sourceId: string,
  signal: AbortSignal,
): SourceRepositoryOperationRuntime & { flush: () => void } {
  const pending = { stdout: "", stderr: "" };

  const consumeLine = (line: string) => {
    const current = latestJobs.get(sourceId);
    if (!current) return;
    const cleaned = cleanLogLine(line);
    const progress = parseSourceGitProgress(line);
    if (!cleaned && !progress) return;
    updateJob(sourceId, {
      ...(cleaned
        ? { logLines: [...current.logLines, cleaned].slice(-MAX_LOG_LINES) }
        : {}),
      ...(progress ?? {}),
    });
  };

  const consumeChunk = (target: "stdout" | "stderr", chunk: string) => {
    const combined = pending[target] + chunk;
    const parts = combined.split(/[\r\n]/);
    pending[target] = parts.pop() ?? "";
    for (const line of parts) consumeLine(line);
  };

  return {
    signal,
    onGitOutput: consumeChunk,
    onPhase: (input) =>
      updateJob(sourceId, {
        phase: input.phase,
        progress: phaseProgress(input.phase, 0),
        message: input.message,
      }),
    flush: () => {
      for (const target of ["stdout", "stderr"] as const) {
        if (pending[target]) consumeLine(pending[target]);
        pending[target] = "";
      }
    },
  };
}

function boundedOutput(value: string): string {
  const redacted = redactGitOutput(value);
  return redacted.length <= MAX_OUTPUT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_OUTPUT_LENGTH)}\n… output truncated`;
}

function startJob(
  sourceId: string,
  operation: SourceRepositoryOperationKind,
  work: (
    runtime: SourceRepositoryOperationRuntime,
  ) => Promise<{ output: string }>,
): SourceRepositoryOperationJob {
  assertSourceRepositoryOperationIdle(sourceId);
  assertSourceContentCanChange(sourceId);

  const job = SourceRepositoryOperationJobSchema.parse({
    id: newId(),
    sourceId,
    operation,
    status: "running",
    phase: operation === "clone" ? "starting" : "updating",
    progress: 0,
    message:
      operation === "clone" ? "Preparing full clone." : "Preparing pull.",
    startedAt: nowIso(),
    finishedAt: null,
    cancelRequested: false,
    output: null,
    error: null,
    logLines: [],
  });
  latestJobs.start(sourceId, job);
  const controller = new AbortController();
  const reporter = createReporter(sourceId, controller.signal);

  const completion = work(reporter)
    .then((result) => {
      reporter.flush();
      const completed = `${operation === "clone" ? "Clone" : "Pull"} completed.`;
      appendLogLine(sourceId, completed);
      updateJob(sourceId, {
        status: "succeeded",
        phase: "complete",
        progress: 100,
        message: completed,
        finishedAt: nowIso(),
        output: boundedOutput(result.output),
        error: null,
      });
    })
    .catch((error) => {
      reporter.flush();
      const message = redactGitOutput((error as Error).message);
      appendLogLine(sourceId, message);
      const canceled = controller.signal.aborted;
      updateJob(sourceId, {
        status: canceled ? "canceled" : "failed",
        message: canceled ? "Canceled by user." : message,
        finishedAt: nowIso(),
        output: null,
        error: canceled ? "canceled by user" : message,
      });
    });
  registerActiveJob({
    domain: SOURCE_JOB_DOMAIN,
    entityId: sourceId,
    jobId: job.id,
    cancel: () => controller.abort(),
    completion,
  });

  return job;
}

export function startSourceRepositoryClone(
  sourceId: string,
  input: SourceRepositoryClone,
): SourceRepositoryOperationJob {
  return startJob(sourceId, "clone", (runtime) =>
    cloneSourceRepository(sourceId, input, runtime),
  );
}

export function startSourceRepositoryPull(
  sourceId: string,
): SourceRepositoryOperationJob {
  return startJob(sourceId, "pull", (runtime) =>
    pullSourceRepository(sourceId, runtime),
  );
}

export function getSourceRepositoryOperationJob(
  sourceId: string,
): SourceRepositoryOperationJob | null {
  return latestJobs.get(sourceId);
}

export function cancelSourceRepositoryOperationJob(
  sourceId: string,
): SourceRepositoryOperationJob {
  const job = latestJobs.get(sourceId);
  const active = getActiveJob(SOURCE_JOB_DOMAIN, sourceId);
  if (!job || job.status !== "running" || active?.jobId !== job.id) {
    throw new Error(
      `no source repository operation is running for ${sourceId}`,
    );
  }
  active.cancel();
  return updateJob(sourceId, {
    cancelRequested: true,
    message: "Canceling source repository operation.",
  })!;
}

export function resetSourceRepositoryOperationJobsForTests(): void {
  for (const active of listActiveJobs(SOURCE_JOB_DOMAIN)) active.cancel();
  resetActiveJobs();
  latestJobs.clear();
}
