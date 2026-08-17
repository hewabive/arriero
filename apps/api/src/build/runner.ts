import type {
  BuildJob,
  BuildJobStart,
  BuildJobStep,
  BuildJobStepName,
  BuildSettings,
} from "@arriero/core";
import {
  createWriteStream,
  existsSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import { basename, resolve } from "node:path";

import { config } from "../config.js";
import { runLoggedCommand } from "../jobs/exec.js";
import { registerActiveJob } from "../jobs/registry.js";
import { markJobStep } from "../jobs/steps.js";
import { listLlamaSourceRefs } from "../llama/source-repository.js";
import { LLAMA_CPP_SOURCE_ID } from "../sources/registry.js";
import { getActiveSourceRepositoryOperation } from "../sources/state.js";
import { relocatedCmakeCacheReason } from "./cmake-cache.js";
import { getPackageRegistriesSettings } from "../settings/registries.js";
import {
  buildProcessEnv,
  buildSteps,
  cleanBuildDirectory,
  commandCwd,
  detectBinaryPath,
  detectRpcServerBinaryPath,
  effectiveCmakeGenerator,
  fitParamsSourceDir,
  resolveBuildRef,
  rpcSourceDir,
  slugifyRef,
  splitCommandChain,
  uiDirectory,
  validateBuildDirectoryCleanTarget,
  validateSettings,
  writeHeader,
} from "./plan.js";
import { assertBuildPrerequisites } from "./preflight.js";
import {
  buildJobs,
  createBuildJob,
  getBuildJob,
  getBuildSettings,
  registerBuiltBinaryInCatalog,
  saveBuildSettings,
  updateBuildJob,
} from "./repository.js";

export {
  buildSteps,
  buildProcessEnv,
  slugifyRef,
  validateBuildDirectoryCleanTarget,
} from "./plan.js";

type RunningBuild = {
  jobId: string;
  controller: AbortController;
  canceled: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

class LlamaBuildRunner {
  private running: RunningBuild | null = null;

  isRunning(): boolean {
    if (!this.running) {
      return false;
    }
    return getBuildJob(this.running.jobId)?.status === "running";
  }

  async start(input: BuildJobStart): Promise<BuildJob> {
    if (getActiveSourceRepositoryOperation(LLAMA_CPP_SOURCE_ID)) {
      throw new Error(
        "cannot start a build while a llama.cpp source operation is running",
      );
    }
    if (this.running) {
      const current = getBuildJob(this.running.jobId);
      if (current?.status === "running") {
        return current;
      }
      this.running = null;
    }

    const baseSettings = input.settings
      ? saveBuildSettings(input.settings)
      : getBuildSettings();

    const refs = await listLlamaSourceRefs();
    if (
      input.gitRef &&
      !refs.branches.includes(input.gitRef) &&
      !refs.tags.includes(input.gitRef)
    ) {
      throw new Error(`unknown git ref: ${input.gitRef}`);
    }

    const targetBranch = input.gitRef
      ? refs.branches.includes(input.gitRef)
        ? input.gitRef
        : null
      : refs.currentBranch;
    const canPull =
      targetBranch !== null && refs.branchesWithUpstream.includes(targetBranch);
    const effectiveInput: BuildJobStart = {
      ...input,
      pull: input.pull && canPull,
    };

    const settings: BuildSettings = {
      ...baseSettings,
      buildDir: resolve(
        baseSettings.buildDir,
        slugifyRef(await resolveBuildRef(input.gitRef)),
      ),
    };
    const env = buildProcessEnv(settings);
    const steps = buildSteps(
      settings,
      effectiveInput,
      env,
      getPackageRegistriesSettings().npmRegistryUrl,
    );
    if (steps.length === 0) {
      throw new Error("at least one build step must be enabled");
    }

    validateSettings(settings, steps);
    await assertBuildPrerequisites(steps, {
      cuda: settings.cuda,
      generator: effectiveCmakeGenerator(steps, settings.buildDir, env),
    });

    const job = createBuildJob({
      status: "running",
      settings,
      steps,
      currentStep: null,
      startedAt: nowIso(),
      logPath: resolve(config.logsDir, `build-${Date.now()}.log`),
    });

    this.running = {
      jobId: job.id,
      controller: new AbortController(),
      canceled: false,
    };
    const completion = this.run(job.id);
    registerActiveJob({
      domain: "build",
      jobId: job.id,
      cancel: () => {
        this.cancel(job.id);
      },
      completion,
    });
    return job;
  }

  cancel(id: string): BuildJob | null {
    if (this.running?.jobId !== id) {
      return getBuildJob(id);
    }

    this.running.canceled = true;
    this.running.controller.abort();
    return updateBuildJob(id, {
      status: "canceled",
      currentStep: null,
      finishedAt: nowIso(),
      exitCode: null,
      error: "canceled by user",
    });
  }

  private async run(jobId: string) {
    let job = getBuildJob(jobId);
    if (!job) {
      this.running = null;
      return;
    }

    const logStream = createWriteStream(job.logPath, { flags: "a" });
    const env = buildProcessEnv(job.settings);
    writeHeader(logStream, job, env);

    try {
      for (const plannedStep of job.steps) {
        if (this.running?.jobId === jobId && this.running.canceled) {
          this.finish(jobId, "canceled", null, null, "canceled by user");
          return;
        }

        if (
          plannedStep.name === "build-fit-params" &&
          !existsSync(fitParamsSourceDir(job.settings))
        ) {
          this.markStep(jobId, plannedStep.name, {
            status: "skipped",
            finishedAt: nowIso(),
            exitCode: null,
          });
          logStream.write(
            `# ${plannedStep.name}: llama-fit-params is not present in this llama.cpp ref; skipping companion tool build\n\n`,
          );
          continue;
        }

        if (
          plannedStep.name === "build-rpc-server" &&
          !existsSync(rpcSourceDir(job.settings))
        ) {
          this.markStep(jobId, plannedStep.name, {
            status: "skipped",
            finishedAt: nowIso(),
            exitCode: null,
          });
          logStream.write(
            `# ${plannedStep.name}: tools/rpc is not present in this llama.cpp ref; skipping rpc-server build\n\n`,
          );
          continue;
        }

        job = this.markStep(jobId, plannedStep.name, {
          status: "running",
          startedAt: nowIso(),
          exitCode: null,
        });

        if (plannedStep.name === "configure") {
          const relocated = relocatedCmakeCacheReason(
            job.settings.buildDir,
            job.settings.repoPath,
          );
          if (relocated) {
            logStream.write(
              `# ${relocated}; CMake cannot reuse a relocated build tree, removing it before configuring\n`,
            );
            cleanBuildDirectory(job.settings, logStream);
          }
        }

        let exitCode: number;
        if (plannedStep.name === "clean-build-dir") {
          logStream.write(`$ ${plannedStep.command.join(" ")}\n`);
          cleanBuildDirectory(job.settings, logStream);
          exitCode = 0;
        } else if (plannedStep.name === "ui-install") {
          exitCode = await this.rebuildUiAssets(
            job.settings,
            plannedStep.command,
            logStream,
            env,
          );
        } else {
          logStream.write(`$ ${plannedStep.command.join(" ")}\n`);
          exitCode = await this.runCommand(
            plannedStep.command,
            commandCwd(job.settings, plannedStep.name),
            logStream,
            env,
          );
        }

        if (this.running?.jobId === jobId && this.running.canceled) {
          this.markStep(jobId, plannedStep.name, {
            status: "failed",
            finishedAt: nowIso(),
            exitCode,
          });
          this.finish(jobId, "canceled", null, null, "canceled by user");
          return;
        }

        if (exitCode !== 0) {
          if (plannedStep.name === "build-fit-params") {
            this.markStep(jobId, plannedStep.name, {
              status: "warning",
              finishedAt: nowIso(),
              exitCode,
            });
            logStream.write(
              `\n# WARNING: ${plannedStep.name} failed (exit ${exitCode}); the exact memory estimate will be unavailable for binaries from this build — continuing (non-fatal). If the failure is "No rule to make target", upstream likely renamed the CMake target.\n\n`,
            );
            continue;
          }
          if (plannedStep.name === "build-rpc-server") {
            this.markStep(jobId, plannedStep.name, {
              status: "warning",
              finishedAt: nowIso(),
              exitCode,
            });
            logStream.write(
              `\n# WARNING: ${plannedStep.name} failed (exit ${exitCode}); the rpc-server worker for multi-machine offload will be unavailable from this build — continuing (non-fatal). If the failure is "No rule to make target", upstream likely renamed the CMake target.\n\n`,
            );
            continue;
          }
          this.markStep(jobId, plannedStep.name, {
            status: "failed",
            finishedAt: nowIso(),
            exitCode,
          });
          this.finish(
            jobId,
            "failed",
            exitCode,
            null,
            `${plannedStep.name} exited with code ${exitCode}`,
          );
          return;
        }

        job = this.markStep(jobId, plannedStep.name, {
          status: "succeeded",
          finishedAt: nowIso(),
          exitCode,
        });
        logStream.write(`\n# ${plannedStep.name} completed\n\n`);
      }

      const binaryPath = detectBinaryPath(job.settings);
      this.finish(jobId, "succeeded", 0, binaryPath, null);
      const rpcStep = job.steps.find(
        (item) => item.name === "build-rpc-server",
      );
      const rpcBuiltThisJob = !rpcStep || rpcStep.status === "succeeded";
      if (job.settings.rpc && !rpcBuiltThisJob) {
        const staleRpcBinary = detectRpcServerBinaryPath(job.settings);
        if (staleRpcBinary) {
          logStream.write(
            `\n# not registering ${staleRpcBinary}: build-rpc-server did not succeed in this job, the file is a stale artifact of a previous build\n`,
          );
        }
      }
      const builtBinaries = [
        binaryPath,
        ...(job.settings.rpc && rpcBuiltThisJob
          ? [detectRpcServerBinaryPath(job.settings)]
          : []),
      ];
      for (const path of builtBinaries) {
        if (!path) {
          continue;
        }
        try {
          const entry = registerBuiltBinaryInCatalog(
            path,
            job.settings.repoPath,
            basename(job.settings.buildDir),
          );
          logStream.write(`\n# registered in path catalog: ${entry.name}\n`);
        } catch (error) {
          logStream.write(
            `\n# failed to register binary in path catalog: ${(error as Error).message}\n`,
          );
        }
      }
    } catch (error) {
      logStream.write(`\n# error: ${(error as Error).message}\n`);
      this.finish(jobId, "failed", null, null, (error as Error).message);
    } finally {
      logStream.end();
      if (this.running?.jobId === jobId) {
        this.running = null;
      }
    }
  }

  private markStep(
    jobId: string,
    name: BuildJobStepName,
    patch: Partial<Omit<BuildJobStep, "name" | "command">>,
  ): BuildJob {
    return markJobStep<BuildJobStep, BuildJob>(buildJobs, jobId, name, patch);
  }

  private finish(
    jobId: string,
    status: "succeeded" | "failed" | "canceled",
    exitCode: number | null,
    binaryPath: string | null,
    error: string | null,
  ) {
    updateBuildJob(jobId, {
      status,
      currentStep: null,
      finishedAt: nowIso(),
      exitCode,
      binaryPath,
      error,
    });
  }

  private async rebuildUiAssets(
    settings: BuildSettings,
    stepCommand: string[],
    logStream: WriteStream,
    env: NodeJS.ProcessEnv,
  ) {
    const uiDir = uiDirectory(settings);
    const distDir = resolve(uiDir, "dist");
    if (existsSync(distDir)) {
      logStream.write(`# removing stale UI source dist ${distDir}\n`);
      rmSync(distDir, { recursive: true, force: true });
    }

    const uiEnv = { ...env, LLAMA_UI_OUT_DIR: distDir };
    for (const command of splitCommandChain(stepCommand)) {
      logStream.write(`$ ${command.join(" ")}\n`);
      const exitCode = await this.runCommand(command, uiDir, logStream, uiEnv);
      if (exitCode !== 0) {
        return exitCode;
      }
    }
    return 0;
  }

  private async runCommand(
    command: string[],
    cwd: string,
    logStream: WriteStream,
    env: NodeJS.ProcessEnv,
  ): Promise<number> {
    const signal = this.running?.controller.signal;
    const result = await runLoggedCommand(command, {
      log: logStream,
      cwd,
      env,
      ...(signal ? { signal } : {}),
    });
    return result.exitCode;
  }
}

export const buildRunner = new LlamaBuildRunner();
