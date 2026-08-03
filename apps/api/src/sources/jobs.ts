import {
  SourceRepositoryOperationJobSchema,
  type SourceRepositoryClone,
  type SourceRepositoryOperationJob,
  type SourceRepositoryOperationKind,
  type SourceRepositoryOperationPhase,
} from "@arriero/core";

import { redactGitOutput } from "../git/process.js";
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

const latestJobs = new Map<string, SourceRepositoryOperationJob>();
const activeControllers = new Map<
  string,
  { jobId: string; controller: AbortController }
>();
const activePromises = new Map<string, Promise<void>>();

function nowIso() {
  return new Date().toISOString();
}

function cloneJob(job: SourceRepositoryOperationJob) {
  return structuredClone(job);
}

function setJob(job: SourceRepositoryOperationJob) {
  const parsed = SourceRepositoryOperationJobSchema.parse(job);
  latestJobs.set(parsed.sourceId, cloneJob(parsed));
  return cloneJob(parsed);
}

function updateJob(
  sourceId: string,
  input: Partial<SourceRepositoryOperationJob>,
): SourceRepositoryOperationJob | null {
  const current = latestJobs.get(sourceId);
  if (!current) return null;
  return setJob({ ...current, ...input, id: current.id, sourceId });
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

function phaseProgress(
  operation: SourceRepositoryOperationKind,
  phase: SourceRepositoryOperationPhase,
  stagePercent: number,
): number {
  const percent = Math.max(0, Math.min(100, stagePercent));
  if (phase === "receiving") return Math.round(5 + percent * 0.65);
  if (phase === "resolving") return Math.round(70 + percent * 0.2);
  if (phase === "checking-out") return Math.round(90 + percent * 0.07);
  if (operation === "pull" && phase === "updating") {
    return Math.max(1, Math.round(percent * 0.97));
  }
  return percent;
}

export function parseSourceGitProgress(
  operation: SourceRepositoryOperationKind,
  line: string,
): {
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
  const stagePercent = Number(match[2]);
  const phase: SourceRepositoryOperationPhase = label.startsWith("receiving")
    ? "receiving"
    : label.startsWith("resolving")
      ? "resolving"
      : "checking-out";
  return {
    phase,
    progress: phaseProgress(operation, phase, stagePercent),
    message: cleanLogLine(line),
  };
}

function createReporter(
  sourceId: string,
  operation: SourceRepositoryOperationKind,
  signal: AbortSignal,
): SourceRepositoryOperationRuntime & { flush: () => void } {
  const pending = { stdout: "", stderr: "" };

  const consumeLine = (line: string) => {
    appendLogLine(sourceId, line);
    const progress = parseSourceGitProgress(operation, line);
    if (progress) updateJob(sourceId, progress);
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
    onPhase: (input) => updateJob(sourceId, input),
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

  const job = setJob({
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
  const controller = new AbortController();
  activeControllers.set(sourceId, { jobId: job.id, controller });
  const reporter = createReporter(sourceId, operation, controller.signal);

  const completion = work(reporter)
    .then((result) => {
      reporter.flush();
      appendLogLine(
        sourceId,
        `${operation === "clone" ? "Clone" : "Pull"} completed.`,
      );
      updateJob(sourceId, {
        status: "succeeded",
        phase: "complete",
        progress: 100,
        message: `${operation === "clone" ? "Clone" : "Pull"} completed.`,
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
    })
    .then(() => undefined);
  activePromises.set(sourceId, completion);
  void completion.finally(() => {
    const active = activeControllers.get(sourceId);
    if (active?.jobId === job.id) activeControllers.delete(sourceId);
    if (activePromises.get(sourceId) === completion) {
      activePromises.delete(sourceId);
    }
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
  const job = latestJobs.get(sourceId);
  return job ? cloneJob(job) : null;
}

export function cancelSourceRepositoryOperationJob(
  sourceId: string,
): SourceRepositoryOperationJob {
  const job = latestJobs.get(sourceId);
  const active = activeControllers.get(sourceId);
  if (!job || job.status !== "running" || active?.jobId !== job.id) {
    throw new Error(
      `no source repository operation is running for ${sourceId}`,
    );
  }
  active.controller.abort();
  return updateJob(sourceId, {
    cancelRequested: true,
    message: "Canceling source repository operation.",
  })!;
}

export function resetSourceRepositoryOperationJobsForTests(): void {
  for (const active of activeControllers.values()) active.controller.abort();
  activeControllers.clear();
  activePromises.clear();
  latestJobs.clear();
}

export async function shutdownSourceRepositoryOperationJobs(
  timeoutMs: number,
): Promise<number> {
  const running = [...activeControllers.values()];
  if (running.length === 0) return 0;
  for (const active of running) active.controller.abort();
  const completions = [...activePromises.values()];
  await Promise.race([
    Promise.allSettled(completions),
    new Promise<void>((resolveDone) => {
      const timer = setTimeout(resolveDone, Math.max(1, timeoutMs));
      timer.unref?.();
    }),
  ]);
  return running.length;
}
