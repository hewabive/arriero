import type {
  UpdateJob,
  UpdateJobStart,
  UpdateJobStep,
  UpdateJobStepName,
} from "@llama-manager/core";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import { config } from "../config.js";
import { beginApiProxyDrain } from "../proxy/drain.js";
import { apiProxyInflight } from "../proxy/inflight.js";
import { apiProxyStreamSessions } from "../proxy/stream-session.js";
import { createUpdateJob, getUpdateJob, patchUpdateJob } from "./repository.js";
import { currentCommit, getManagerVersion } from "./version.js";

const RESTART_DELAY_MS = 800;

type RunningUpdate = {
  jobId: string;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
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

    const version = getManagerVersion();
    if (!version.canUpdate) {
      throw new Error(
        version.updateBlockedReason ??
          "update is not available in this run mode",
      );
    }
    if (version.dirty) {
      throw new Error(
        "the llama-manager working tree is dirty; commit or discard changes before updating (git pull --ff-only would fail)",
      );
    }

    const willRestart = input.restart && version.supervised;
    const job = createUpdateJob({
      steps: plannedSteps(willRestart),
      fromCommit: version.commit,
      willRestart,
      startedAt: nowIso(),
      logPath: resolve(config.logsDir, `update-${Date.now()}.log`),
    });

    this.running = { jobId: job.id, child: null, canceled: false };
    void this.run(job.id);
    return job;
  }

  cancel(id: string): UpdateJob | null {
    if (this.running?.jobId !== id) {
      return getUpdateJob(id);
    }
    this.running.canceled = true;
    this.running.child?.kill("SIGTERM");
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
    logStream.write(`# llama-manager update ${job.startedAt}\n`);
    logStream.write(`# repo: ${config.rootDir}\n`);
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
        logStream.write(`$ ${command.join(" ")}\n`);
        const exitCode = await this.runCommand(command, logStream);

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
          "\n# build complete; restarting the manager to apply (systemd will bring it back up)\n",
        );
        logStream.end();
        this.scheduleRestart();
        return;
      }

      this.finish(jobId, "succeeded", null, toCommit);
      logStream.write(
        "\n# update complete; restart the manager to apply the new code\n",
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
    beginApiProxyDrain();
    const deadline = Date.now() + config.update.drainTimeoutMs;
    const fire = () => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(0);
      }
    };
    const poll = setInterval(() => {
      const nonResumable =
        apiProxyInflight.activeCount() - apiProxyStreamSessions.size();
      if (nonResumable > 0 && Date.now() < deadline) {
        return;
      }
      clearInterval(poll);
      setTimeout(fire, RESTART_DELAY_MS);
    }, 500);
    poll.unref?.();
  }

  private async rollback(fromCommit: string | null, logStream: WriteStream) {
    if (!fromCommit) {
      return;
    }
    logStream.write(
      `\n# rolling back source to ${fromCommit} (step failed; not restarting)\n`,
    );
    try {
      await this.runCommand(["git", "reset", "--hard", fromCommit], logStream);
    } catch (error) {
      logStream.write(`# rollback failed: ${(error as Error).message}\n`);
    }
  }

  private markStep(
    jobId: string,
    name: UpdateJobStepName,
    patch: Partial<Omit<UpdateJobStep, "name">>,
  ): UpdateJob {
    const current = getUpdateJob(jobId);
    if (!current) {
      throw new Error(`update job not found: ${jobId}`);
    }
    const steps = current.steps.map((item) =>
      item.name === name ? { ...item, ...patch } : item,
    );
    const updated = patchUpdateJob(jobId, {
      steps,
      currentStep: patch.status === "running" ? name : current.currentStep,
    });
    if (!updated) {
      throw new Error(`update job not found: ${jobId}`);
    }
    return updated;
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

  private runCommand(
    command: string[],
    logStream: WriteStream,
  ): Promise<number> {
    return new Promise((resolveDone, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        cwd: config.rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;

      if (this.running) {
        this.running.child = child;
      }

      child.stdout.on("data", (chunk: Buffer) => logStream.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => logStream.write(chunk));

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.running?.child === child) {
          this.running.child = null;
        }
        if (signal) {
          logStream.write(`\n# terminated by ${signal}\n`);
        }
        resolveDone(code ?? 1);
      });
    });
  }
}

export const updateRunner = new UpdateRunner();
