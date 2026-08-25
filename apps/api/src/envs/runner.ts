import type {
  EnvironmentJob,
  EnvironmentJobStep,
  EnvironmentJobStepName,
  EnvironmentRepositorySettings,
  EnvironmentSpec,
} from "@arriero/core";
import {
  createWriteStream,
  existsSync,
  renameSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { runLoggedCommand } from "../jobs/exec.js";
import { registerActiveJob } from "../jobs/registry.js";
import { markJobStep } from "../jobs/steps.js";
import { environmentLogFileName } from "../logs/log-names.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import { discardDirectory } from "../utils/discard.js";
import {
  environmentDirectory,
  environmentEntrypoint,
  environmentStagingDirectory,
} from "./paths.js";
import { environmentLayoutError } from "./validation.js";
import {
  environmentProvisioner,
  type EnvironmentTooling,
} from "./provisioners.js";
import {
  createEnvironmentJob,
  environmentJobs,
  getEnvironmentJob,
  updateEnvironmentJob,
} from "./repository.js";
import { getEnvironmentRepositorySettings } from "./settings.js";

const UV_ENVIRONMENT_PASSTHROUGH = new Set([
  "UV_CREDENTIALS_DIR",
  "UV_HTTP_CONNECT_TIMEOUT",
  "UV_HTTP_RETRIES",
  "UV_HTTP_TIMEOUT",
  "UV_INSECURE_HOST",
  "UV_KEYRING_PROVIDER",
  "UV_NATIVE_TLS",
  "UV_NO_PROGRESS",
  "UV_SYSTEM_CERTS",
]);

function uvEnvironmentPassthrough(key: string) {
  return (
    UV_ENVIRONMENT_PASSTHROUGH.has(key) ||
    /^UV_INDEX_[A-Z0-9_]+_(?:USERNAME|PASSWORD)$/.test(key)
  );
}

export function environmentUvProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("UV_") && !uvEnvironmentPassthrough(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    UV_CACHE_DIR: config.uvCacheDir,
    UV_NO_CONFIG: "1",
    UV_PYTHON_INSTALL_DIR: config.pythonDir,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function environmentJobSteps(
  spec: EnvironmentSpec,
  tools: EnvironmentTooling,
  repositories: EnvironmentRepositorySettings,
): EnvironmentJobStep[] {
  return environmentProvisioner(spec.engine).jobSteps(
    spec,
    tools,
    {
      staging: environmentStagingDirectory(spec),
      final: environmentDirectory(spec),
    },
    repositories,
  );
}

type Running = {
  jobId: string;
  environmentId: string;
  controller: AbortController;
  canceled: boolean;
  done: Promise<void>;
};

class EnvironmentRunner {
  private running: Running | null = null;

  activeEnvironmentId() {
    return this.running?.environmentId ?? null;
  }

  start(spec: EnvironmentSpec, tools: EnvironmentTooling): EnvironmentJob {
    if (
      this.running &&
      getEnvironmentJob(this.running.jobId)?.status === "running"
    ) {
      throw new Error("another environment installation is already running");
    }
    const repositories = getEnvironmentRepositorySettings();
    const finalDir = environmentDirectory(spec);
    if (existsSync(finalDir))
      throw new Error("environment is already installed");
    const job = createEnvironmentJob({
      environmentId: spec.id,
      steps: environmentJobSteps(spec, tools, repositories),
      logPath: resolve(
        config.logsDir,
        environmentLogFileName(spec.id, Date.now()),
      ),
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    this.running = {
      jobId: job.id,
      environmentId: spec.id,
      controller: new AbortController(),
      canceled: false,
      done,
    };
    void this.run(spec, job.id).finally(resolveDone);
    registerActiveJob({
      domain: "envs",
      jobId: job.id,
      cancel: () => {
        this.cancel(job.id);
      },
      completion: done,
    });
    return job;
  }

  cancel(jobId: string) {
    if (this.running?.jobId !== jobId) return getEnvironmentJob(jobId);
    this.running.canceled = true;
    this.running.controller.abort();
    return updateEnvironmentJob(jobId, {
      status: "canceled",
      currentStep: null,
      finishedAt: nowIso(),
      error: "canceled by user",
    });
  }

  async shutdown() {
    const current = this.running;
    if (!current) return;
    this.cancel(current.jobId);
    await current.done;
  }

  private async run(spec: EnvironmentSpec, jobId: string) {
    const staging = environmentStagingDirectory(spec);
    const finalDir = environmentDirectory(spec);
    discardDirectory(staging);
    const log = createWriteStream(getEnvironmentJob(jobId)!.logPath, {
      flags: "a",
    });
    let finalized = false;
    let activeExitCode: number | null = null;
    const provisioner = environmentProvisioner(spec.engine);
    try {
      for (const planned of getEnvironmentJob(jobId)!.steps) {
        if (this.running?.canceled) throw new Error("canceled by user");
        this.mark(jobId, planned.name, "running", null);
        activeExitCode = null;
        log.write(`$ ${planned.command.join(" ")}\n`);
        let output = "";
        let exitCode = 0;
        const inProcessStep = provisioner.inProcessSteps[planned.name];
        if (planned.name === "finalize") {
          provisioner.prepareFinalize(spec, staging);
          const stagingEntrypoint = resolve(
            staging,
            provisioner.entrypointRelative,
          );
          if (!existsSync(stagingEntrypoint)) {
            throw new Error(
              `${provisioner.displayName} entrypoint was not installed: ${stagingEntrypoint}`,
            );
          }
          renameSync(staging, finalDir);
          finalized = true;
        } else if (inProcessStep) {
          await inProcessStep({ spec, stagingDir: staging, log });
        } else {
          const result = await this.runCommand(planned.command, log);
          output = result.stdout;
          exitCode = result.exitCode;
          activeExitCode = exitCode;
        }
        if (this.running?.canceled) throw new Error("canceled by user");
        if (exitCode !== 0)
          throw new Error(`${planned.name} exited with code ${exitCode}`);
        if (planned.name === "freeze") {
          writeFileSync(resolve(staging, "freeze.txt"), output, "utf8");
        }
        if (planned.name === "validate") {
          const layoutError = environmentLayoutError(spec);
          if (layoutError) throw new Error(layoutError);
        }
        this.mark(jobId, planned.name, "succeeded", exitCode);
        log.write(`\n# ${planned.name} completed\n\n`);
      }
      if (!existsSync(environmentEntrypoint(spec))) {
        throw new Error(
          `finalized ${provisioner.displayName} entrypoint is missing`,
        );
      }
      const entry = reconcileEnvironmentCatalog(spec);
      if (entry) {
        log.write(`# registered in path catalog: ${entry.name}\n`);
      }
      updateEnvironmentJob(jobId, {
        status: "succeeded",
        currentStep: null,
        finishedAt: nowIso(),
        error: null,
      });
    } catch (error) {
      const canceled = this.running?.canceled === true;
      const current = getEnvironmentJob(jobId);
      const runningStep = current?.steps.find(
        (step) => step.status === "running",
      );
      if (runningStep) {
        this.mark(jobId, runningStep.name, "failed", activeExitCode);
      }
      discardDirectory(staging);
      if (finalized) discardDirectory(finalDir);
      log.write(`\n# error: ${(error as Error).message}\n`);
      updateEnvironmentJob(jobId, {
        status: canceled ? "canceled" : "failed",
        currentStep: null,
        finishedAt: nowIso(),
        error: (error as Error).message,
      });
    } finally {
      log.end();
      if (this.running?.jobId === jobId) this.running = null;
    }
  }

  private mark(
    jobId: string,
    name: EnvironmentJobStepName,
    status: EnvironmentJobStep["status"],
    exitCode: number | null,
  ) {
    const now = nowIso();
    markJobStep<EnvironmentJobStep, EnvironmentJob>(
      environmentJobs,
      jobId,
      name,
      status === "running"
        ? { status, startedAt: now, finishedAt: null, exitCode }
        : { status, finishedAt: now, exitCode },
    );
  }

  private runCommand(command: string[], log: WriteStream) {
    const signal = this.running?.controller.signal;
    return runLoggedCommand(command, {
      log,
      collectStdout: true,
      env: environmentUvProcessEnvironment(),
      ...(signal ? { signal } : {}),
    });
  }
}

export const environmentRunner = new EnvironmentRunner();
