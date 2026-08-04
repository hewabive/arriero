import type {
  PrerequisiteInstallCapability,
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
} from "@arriero/core";
import { spawn, type ChildProcess } from "node:child_process";

import { newId } from "../utils/id.js";
import { INSTALL_COMMAND_SEPARATOR } from "./install-plan.js";

const LOG_LIMIT_CHARS = 256 * 1024;

export function executedInstallCommand(
  command: string,
  method: PrerequisiteInstallCapability["method"],
): string {
  if (method !== "root") {
    return command;
  }
  return command
    .split(INSTALL_COMMAND_SEPARATOR)
    .map((part) => part.replace(/^sudo\s+/, ""))
    .join(INSTALL_COMMAND_SEPARATOR);
}

export class PrerequisiteInstallRunner {
  private run: PrerequisiteInstallRun | null = null;
  private child: ChildProcess | null = null;
  private settled: Promise<void> = Promise.resolve();

  latest(): PrerequisiteInstallRun | null {
    return this.run ? { ...this.run } : null;
  }

  isRunning(): boolean {
    return this.run?.status === "running";
  }

  start(
    request: PrerequisiteInstallStart,
    command: string,
    method: PrerequisiteInstallCapability["method"],
  ): PrerequisiteInstallRun {
    if (this.isRunning()) {
      throw new Error("a package installation is already running");
    }
    const run: PrerequisiteInstallRun = {
      id: newId(),
      request,
      command: executedInstallCommand(command, method),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      log: "",
    };
    this.run = run;
    this.settled = this.execute(run);
    return { ...run };
  }

  waitForCompletion(): Promise<void> {
    return this.settled;
  }

  private execute(run: PrerequisiteInstallRun): Promise<void> {
    return new Promise((resolveDone) => {
      const child = spawn("bash", ["-c", run.command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
      });
      this.child = child;
      let settled = false;

      const append = (chunk: Buffer | string) => {
        run.log = (run.log + chunk.toString()).slice(-LOG_LIMIT_CHARS);
      };
      const finish = (exitCode: number | null, failure: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.child === child) {
          this.child = null;
        }
        if (failure) {
          append(`\n${failure}\n`);
        }
        run.exitCode = exitCode;
        run.status = exitCode === 0 ? "succeeded" : "failed";
        run.finishedAt = new Date().toISOString();
        resolveDone();
      };

      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => finish(null, error.message));
      child.on("close", (code, signal) =>
        finish(code, signal ? `terminated by ${signal}` : null),
      );
    });
  }
}

export const prerequisiteInstallRunner = new PrerequisiteInstallRunner();
