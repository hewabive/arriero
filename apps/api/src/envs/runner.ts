import type {
  EnvironmentJob,
  EnvironmentJobStep,
  EnvironmentJobStepName,
  EnvironmentSpec,
} from "@arriero/core";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import { runLoggedCommand } from "../jobs/exec.js";
import { registerActiveJob } from "../jobs/registry.js";
import { markJobStep } from "../jobs/steps.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import {
  environmentDirectory,
  environmentEntrypoint,
  environmentStagingDirectory,
} from "./paths.js";
import { environmentLayoutError } from "./validation.js";
import { environmentProvisioner } from "./provisioners.js";
import {
  createEnvironmentJob,
  environmentJobs,
  getEnvironmentJob,
  updateEnvironmentJob,
} from "./repository.js";
import {
  assertUvPythonAvailable,
  findUv,
  uvPythonPreflightCommand,
} from "./uv.js";

type LocalWheelArtifact = {
  path: string;
  sha256: string;
};

function nowIso() {
  return new Date().toISOString();
}

function localWheelArtifacts(spec: EnvironmentSpec): LocalWheelArtifact[] {
  const sources =
    spec.engine === "vllm" && spec.source.kind === "wheel"
      ? [spec.source]
      : spec.engine === "ktransformers" && spec.source.kind === "wheels"
        ? spec.source.artifacts
        : [];
  return sources.flatMap((artifact) => {
    if (!artifact.sha256 || new URL(artifact.url).protocol !== "file:") {
      return [];
    }
    return [
      {
        path: fileURLToPath(artifact.url),
        sha256: artifact.sha256.toLowerCase(),
      },
    ];
  });
}

function sha256File(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function verifyLocalWheelArtifacts(
  spec: EnvironmentSpec,
  log: WriteStream,
) {
  for (const artifact of localWheelArtifacts(spec)) {
    const actual = await sha256File(artifact.path);
    if (actual !== artifact.sha256) {
      throw new Error(
        `wheel SHA-256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    log.write(`# verified SHA-256 ${actual}  ${artifact.path}\n`);
  }
}

export function environmentJobSteps(
  spec: EnvironmentSpec,
  uv: string,
): EnvironmentJobStep[] {
  const staging = environmentStagingDirectory(spec);
  const final = environmentDirectory(spec);
  const python = resolve(staging, "bin", "python");
  const provisioner = environmentProvisioner(spec.engine);
  const install = [
    uv,
    "pip",
    "install",
    "--python",
    python,
    ...provisioner.requirements(spec),
    ...provisioner.installOptions(spec),
  ];
  const step = (
    name: EnvironmentJobStepName,
    command: string[],
  ): EnvironmentJobStep => ({
    name,
    command,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  });
  return [
    spec.pythonProvisioning === "require-existing"
      ? step(
          "python-preflight",
          uvPythonPreflightCommand(uv, spec.pythonVersion),
        )
      : step(
          "python-install",
          spec.pythonProvisioning === "mirror"
            ? [
                uv,
                "python",
                "install",
                "--mirror",
                spec.pythonMirrorUrl!,
                spec.pythonVersion,
              ]
            : [uv, "python", "install", spec.pythonVersion],
        ),
    step("venv-create", [
      uv,
      "venv",
      "--relocatable",
      "--python",
      spec.pythonVersion,
      staging,
    ]),
    ...(localWheelArtifacts(spec).length
      ? [step("artifact-verify", ["verify-local-wheel-sha256"])]
      : []),
    step("package-install", install),
    step("freeze", [
      uv,
      "pip",
      "list",
      "--format",
      "freeze",
      "--python",
      python,
    ]),
    step("finalize", ["finalize-environment", staging, final]),
    step("validate", provisioner.validationCommand(spec, final)),
  ];
}

type Running = {
  jobId: string;
  environmentId: string;
  controller: AbortController;
  canceled: boolean;
  done: Promise<void>;
};

export class EnvironmentRunner {
  private running: Running | null = null;

  activeEnvironmentId() {
    return this.running?.environmentId ?? null;
  }

  start(spec: EnvironmentSpec): EnvironmentJob {
    if (
      this.running &&
      getEnvironmentJob(this.running.jobId)?.status === "running"
    ) {
      throw new Error("another environment installation is already running");
    }
    const uv = findUv();
    if (!uv) throw new Error("uv was not found on PATH");
    if (spec.pythonProvisioning === "require-existing") {
      assertUvPythonAvailable(uv, spec.pythonVersion);
    }
    const finalDir = environmentDirectory(spec);
    if (existsSync(finalDir))
      throw new Error("environment is already installed");
    const job = createEnvironmentJob({
      environmentId: spec.id,
      steps: environmentJobSteps(spec, uv),
      logPath: resolve(config.logsDir, `env-${spec.id}-${Date.now()}.log`),
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
    rmSync(staging, { recursive: true, force: true });
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
        if (planned.name === "artifact-verify") {
          await verifyLocalWheelArtifacts(spec, log);
        } else if (planned.name === "finalize") {
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
      log.write(`# registered in path catalog: ${entry.name}\n`);
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
      rmSync(staging, { recursive: true, force: true });
      if (finalized) rmSync(finalDir, { recursive: true, force: true });
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
      ...(signal ? { signal } : {}),
    });
  }
}

export const environmentRunner = new EnvironmentRunner();
