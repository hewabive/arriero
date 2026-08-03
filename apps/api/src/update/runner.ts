import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";

import { runLoggedCommand } from "../jobs/exec.js";
import { markJobStep } from "../jobs/steps.js";
import { updateAdapter } from "./adapter.js";
import type {
  UpdateJob,
  UpdateJobStart,
  UpdateJobStep,
  UpdateJobStepName,
} from "./adapter.js";
import {
  createUpdateJob,
  getUpdateJob,
  patchUpdateJob,
  updateJobs,
} from "./repository.js";
import { currentCommit, getAppVersion } from "./version.js";

const RESTART_DELAY_MS = 800;

type RunningUpdate = {
  jobId: string;
  controller: AbortController;
  canceled: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

const PIPELINE_STEPS: UpdateJobStepName[] = ["git-pull", "install", "build"];

function commandForStep(step: UpdateJobStepName): string[] {
  switch (step) {
    case "git-pull":
      return ["git", "pull", "--ff-only"];
    case "install":
      return ["pnpm", "install"];
    case "build":
      return ["pnpm", "build"];
    default:
      throw new Error(`no command for step: ${step}`);
  }
}

export function updateStepEnvironment(
  step: UpdateJobStepName,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (step !== "install") {
    return baseEnvironment;
  }
  return { ...baseEnvironment, CI: "true" };
}

function plannedSteps(willRestart: boolean): UpdateJobStep[] {
  const names: UpdateJobStepName[] = ["snapshot", ...PIPELINE_STEPS];
  if (willRestart) {
    names.push("restart");
  }
  return names.map((name) => ({
    name,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  }));
}

class UpdateRunner {
  private running: RunningUpdate | null = null;

  isRunning(): boolean {
    if (!this.running) {
      return false;
    }
    return getUpdateJob(this.running.jobId)?.status === "running";
  }

  start(input: UpdateJobStart): UpdateJob {
    if (this.isRunning()) {
      return getUpdateJob(this.running!.jobId)!;
    }
    this.running = null;

    const version = getAppVersion();
    if (!version.canUpdate) {
      throw new Error(
        version.updateBlockedReason ??
          "update is not available in this run mode",
      );
    }
    if (version.dirty) {
      throw new Error(
        `the ${updateAdapter.appName} working tree is dirty; commit or discard changes before updating (git pull --ff-only would fail)`,
      );
    }

    const willRestart = input.restart && version.supervised;
    const job = createUpdateJob({
      steps: plannedSteps(willRestart),
      fromCommit: version.commit,
      willRestart,
      startedAt: nowIso(),
      logPath: resolve(updateAdapter.logsDir, `update-${Date.now()}.log`),
    });

    this.running = {
      jobId: job.id,
      controller: new AbortController(),
      canceled: false,
    };
    void this.run(job.id);
    return job;
  }

  cancel(id: string): UpdateJob | null {
    if (this.running?.jobId !== id) {
      return getUpdateJob(id);
    }
    this.running.canceled = true;
    this.running.controller.abort();
    return patchUpdateJob(id, {
      status: "canceled",
      currentStep: null,
      finishedAt: nowIso(),
      error: "canceled by user",
    });
  }

  private isCanceled(jobId: string): boolean {
    return this.running?.jobId === jobId && this.running.canceled;
  }

  private async run(jobId: string) {
    const job = getUpdateJob(jobId);
    if (!job) {
      this.running = null;
      return;
    }

    const logStream = createWriteStream(job.logPath, { flags: "a" });
    logStream.write(`# ${updateAdapter.appName} update ${job.startedAt}\n`);
    logStream.write(`# repo: ${updateAdapter.rootDir}\n`);
    logStream.write(`# from commit: ${job.fromCommit ?? "unknown"}\n`);
    logStream.write(`# restart after build: ${job.willRestart}\n\n`);

    const fromCommit = job.fromCommit;

    try {
      this.markStep(jobId, "snapshot", {
        status: "succeeded",
        startedAt: nowIso(),
        finishedAt: nowIso(),
        exitCode: 0,
      });

      for (const step of PIPELINE_STEPS) {
        if (this.isCanceled(jobId)) {
          this.finishCanceled(jobId);
          logStream.end();
          this.clearRunning(jobId);
          return;
        }

        const command = commandForStep(step);
        this.markStep(jobId, step, { status: "running", startedAt: nowIso() });
        const environment = updateStepEnvironment(step);
        const environmentPrefix = step === "install" ? "CI=true " : "";
        logStream.write(`$ ${environmentPrefix}${command.join(" ")}\n`);
        const exitCode = await this.runStep(command, logStream, environment);

        if (this.isCanceled(jobId)) {
          this.markStep(jobId, step, {
            status: "failed",
            finishedAt: nowIso(),
            exitCode,
          });
          this.finishCanceled(jobId);
          logStream.end();
          this.clearRunning(jobId);
          return;
        }

        if (exitCode !== 0) {
          this.markStep(jobId, step, {
            status: "failed",
            finishedAt: nowIso(),
            exitCode,
          });
          await this.rollback(fromCommit, logStream);
          this.finish(jobId, "failed", `${step} exited with code ${exitCode}`);
          logStream.end();
          this.clearRunning(jobId);
          return;
        }

        this.markStep(jobId, step, {
          status: "succeeded",
          finishedAt: nowIso(),
          exitCode,
        });
        logStream.write(`\n# ${step} completed\n\n`);
      }

      const toCommit = currentCommit();
      patchUpdateJob(jobId, { toCommit });
      logStream.write(`# updated ${fromCommit ?? "?"} -> ${toCommit ?? "?"}\n`);

      if (job.willRestart) {
        this.markStep(jobId, "restart", {
          status: "running",
          startedAt: nowIso(),
        });
        patchUpdateJob(jobId, { toCommit });
        logStream.write(
          "\n# build complete; restarting to apply (systemd will bring the process back up)\n",
        );
        logStream.end();
        this.scheduleRestart();
        return;
      }

      this.finish(jobId, "succeeded", null, toCommit);
      logStream.write(
        "\n# update complete; restart the process to apply the new code\n",
      );
      logStream.end();
      this.clearRunning(jobId);
    } catch (error) {
      logStream.write(`\n# error: ${(error as Error).message}\n`);
      await this.rollback(fromCommit, logStream);
      this.finish(jobId, "failed", (error as Error).message);
      logStream.end();
      this.clearRunning(jobId);
    }
  }

  private scheduleRestart() {
    const fire = () => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(0);
      }
    };
    void updateAdapter.beforeRestart().finally(() => {
      setTimeout(fire, RESTART_DELAY_MS).unref?.();
    });
  }

  private async rollback(fromCommit: string | null, logStream: WriteStream) {
    if (!fromCommit) {
      return;
    }
    logStream.write(
      `\n# rolling back source to ${fromCommit} (step failed; not restarting)\n`,
    );
    try {
      await runLoggedCommand(["git", "reset", "--hard", fromCommit], {
        log: logStream,
        cwd: updateAdapter.rootDir,
      });
    } catch (error) {
      logStream.write(`# rollback failed: ${(error as Error).message}\n`);
    }
  }

  private markStep(
    jobId: string,
    name: UpdateJobStepName,
    patch: Partial<Omit<UpdateJobStep, "name">>,
  ): UpdateJob {
    return markJobStep<UpdateJobStep, UpdateJob>(updateJobs, jobId, name, patch);
  }

  private finish(
    jobId: string,
    status: "succeeded" | "failed",
    error: string | null,
    toCommit: string | null = null,
  ) {
    patchUpdateJob(jobId, {
      status,
      currentStep: null,
      finishedAt: nowIso(),
      error,
      ...(toCommit !== null ? { toCommit } : {}),
    });
  }

  private finishCanceled(jobId: string) {
    patchUpdateJob(jobId, {
      status: "canceled",
      currentStep: null,
      finishedAt: nowIso(),
      error: "canceled by user",
    });
  }

  private clearRunning(jobId: string) {
    if (this.running?.jobId === jobId) {
      this.running = null;
    }
  }

  private async runStep(
    command: string[],
    logStream: WriteStream,
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    const signal = this.running?.controller.signal;
    const result = await runLoggedCommand(command, {
      log: logStream,
      cwd: updateAdapter.rootDir,
      env: environment,
      ...(signal ? { signal } : {}),
    });
    return result.exitCode;
  }
}

export const updateRunner = new UpdateRunner();
