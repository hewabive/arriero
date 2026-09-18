import type {
  PrerequisiteInstallCapability,
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
} from "@arriero/core";
import { spawn } from "node:child_process";

import { newId } from "../utils/id.js";
import { InstallProcessTree } from "./install-process-tree.js";

const LOG_LIMIT_CHARS = 256 * 1024;

type PrerequisiteInstallRunOptions = {
  onSucceeded?: () => void;
};

export function executedInstallCommand(
  command: string,
  method: PrerequisiteInstallCapability["method"],
): string {
  if (method === null) {
    return command;
  }
  return command.replace(
    /\\.|'[^']*'|"(?:\\.|[^"\\])*"|(^|&&|\|\||[;(])(\s*)sudo\s+/g,
    (match, boundary: string | undefined, whitespace: string | undefined) =>
      boundary === undefined
        ? match
        : `${boundary}${whitespace ?? ""}${method === "root" ? "" : "sudo -n env DEBIAN_FRONTEND=noninteractive "}`,
  );
}

export class PrerequisiteInstallRunner {
  private run: PrerequisiteInstallRun | null = null;
  private cancelActive: (() => Promise<void>) | null = null;
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
    options: PrerequisiteInstallRunOptions = {},
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
    this.settled = this.execute(run, method, options);
    return { ...run };
  }

  waitForCompletion(): Promise<void> {
    return this.settled;
  }

  async cancel(): Promise<PrerequisiteInstallRun | null> {
    const run = this.run;
    await this.cancelActive?.();
    return run ? { ...run } : null;
  }

  private execute(
    run: PrerequisiteInstallRun,
    method: PrerequisiteInstallCapability["method"],
    options: PrerequisiteInstallRunOptions,
  ): Promise<void> {
    return new Promise((resolveDone) => {
      const child = spawn("bash", ["-c", run.command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
        detached: true,
      });
      let settled = false;
      let cancelling = false;
      let cancellation: Promise<void> | null = null;
      const processes = child.pid
        ? new InstallProcessTree(child.pid, method)
        : null;

      const append = (chunk: Buffer | string) => {
        run.log = (run.log + chunk.toString()).slice(-LOG_LIMIT_CHARS);
      };
      const finish = (
        exitCode: number | null,
        failure: string | null,
        cancelled = false,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        this.cancelActive = null;
        if (failure) {
          append(`\n${failure}\n`);
        }
        if (!cancelled && exitCode === 0 && options.onSucceeded) {
          try {
            options.onSucceeded();
          } catch (error) {
            append(
              `\npost-install state warning: ${(error as Error).message}\n`,
            );
          }
        }
        run.exitCode = exitCode;
        run.status = cancelled
          ? "canceled"
          : exitCode === 0
            ? "succeeded"
            : "failed";
        run.finishedAt = new Date().toISOString();
        resolveDone();
      };

      this.cancelActive = () => {
        if (cancellation) return cancellation;
        cancelling = true;
        append("\nCancellation requested\n");
        cancellation = (async () => {
          try {
            await processes?.terminate();
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(child.exitCode, "Installation cancelled", true);
          } catch (error) {
            append(`\nCancellation failed: ${(error as Error).message}\n`);
            cancellation = null;
            throw error;
          }
        })();
        return cancellation;
      };

      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => {
        if (!cancelling) finish(null, error.message);
      });
      child.on("close", (code, signal) => {
        if (!cancelling)
          finish(code, signal ? `terminated by ${signal}` : null);
      });
    });
  }
}

export const prerequisiteInstallRunner = new PrerequisiteInstallRunner();
