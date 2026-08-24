import type { WebappRuntimeStatus, WebappStopReason } from "@arriero/core";
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  openSync,
  statSync,
  type WriteStream,
} from "node:fs";

import { config } from "../config.js";
import { filterRoutineProbeLogChunk } from "../process/log-filter.js";
import { isPidAlive } from "../process/pid.js";
import { RawLogTail } from "../process/raw-log-tail.js";
import {
  createWebappRun,
  updateWebappRun,
  type WebappRun,
} from "./runs-repository.js";
import { webappLogPaths } from "./paths.js";

type WebappLaunchPlan = {
  name: string;
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  serializedSnapshot: string;
};

export type WebappRuntimeState = {
  name: string;
  pid: number | null;
  status: WebappRuntimeStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  logPath: string | null;
  rawLogPath: string | null;
  adopted: boolean;
};

type WebappRuntime = WebappRuntimeState & {
  runId: string;
  child: ChildProcess | null;
  filteredStream: WriteStream;
  tail: RawLogTail | null;
  exitWaiters: Array<() => void>;
  pendingStopReason: WebappStopReason | null;
  forceKillTimer?: NodeJS.Timeout;
  adoptedExitPoll?: NodeJS.Timeout;
};

type WebappSupervisorShutdownResult = {
  requested: number;
  stopped: number;
  forced: number;
  skipped: number;
};

const ADOPTED_EXIT_POLL_INTERVAL_MS = 1_000;

function nowIso() {
  return new Date().toISOString();
}

class WebappSupervisor {
  private readonly processes = new Map<string, WebappRuntime>();

  getState(name: string): WebappRuntimeState | undefined {
    const runtime = this.processes.get(name);
    if (!runtime) {
      return undefined;
    }
    return {
      name: runtime.name,
      pid: runtime.pid,
      status: runtime.status,
      startedAt: runtime.startedAt,
      stoppedAt: runtime.stoppedAt,
      exitCode: runtime.exitCode,
      logPath: runtime.logPath,
      rawLogPath: runtime.rawLogPath,
      adopted: runtime.adopted,
    };
  }

  launch(plan: WebappLaunchPlan): WebappRuntimeState {
    const current = this.processes.get(plan.name);
    if (current && !this.isTerminal(current)) {
      return this.getState(plan.name)!;
    }

    const startedAt = nowIso();
    const { logPath, rawLogPath } = webappLogPaths(plan.name, Date.now());
    const filteredStream = createWriteStream(logPath, { flags: "a" });
    filteredStream.on("error", () => undefined);
    filteredStream.write(
      [
        `# arriero filtered log for webapp ${plan.name}`,
        `# raw log: ${rawLogPath}`,
        "",
      ].join("\n"),
    );
    appendFileSync(
      rawLogPath,
      [
        `# arriero raw log for webapp ${plan.name}`,
        `# filtered log: ${logPath}`,
        "",
      ].join("\n"),
    );
    const tailStartOffset = statSync(rawLogPath).size;

    const childLogFd = openSync(rawLogPath, "a");
    const child = spawn(plan.binaryPath, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["ignore", childLogFd, childLogFd],
      detached: true,
    });
    closeSync(childLogFd);
    child.unref();

    const runId = createWebappRun({
      webappId: plan.name,
      pid: child.pid ?? null,
      status: "starting",
      startedAt,
      logPath,
      rawLogPath,
      launchSnapshot: plan.serializedSnapshot,
    });

    const runtime: WebappRuntime = {
      name: plan.name,
      runId,
      adopted: false,
      child,
      filteredStream,
      tail: null,
      exitWaiters: [],
      pendingStopReason: null,
      pid: child.pid ?? null,
      status: "starting",
      startedAt,
      stoppedAt: null,
      exitCode: null,
      logPath,
      rawLogPath,
    };

    this.processes.set(plan.name, runtime);
    runtime.tail = this.startTail(runtime, rawLogPath, tailStartOffset);

    child.on("spawn", () => {
      if (this.isTerminal(runtime)) {
        return;
      }
      runtime.status = "running";
      updateWebappRun(runtime.runId, { pid: runtime.pid, status: "running" });
    });

    child.on("error", (error) => {
      this.finalizeExit(runtime, {
        status: "error",
        exitCode: null,
        marker: `ERROR ${error.message}`,
      });
    });

    child.on("exit", (code) => {
      const requested = runtime.status === "stopping";
      this.finalizeExit(runtime, {
        status: requested ? "exited" : "error",
        exitCode: code,
        marker: requested
          ? `EXIT code=${code ?? "signal"}`
          : `ERROR process exited unexpectedly code=${code ?? "signal"}`,
      });
    });

    return this.getState(plan.name)!;
  }

  adopt(name: string, run: WebappRun, pid: number): WebappRuntimeState {
    const current = this.processes.get(name);
    if (current && !this.isTerminal(current)) {
      return this.getState(name)!;
    }

    const adoptedAt = nowIso();
    const filteredStream = createWriteStream(run.logPath, { flags: "a" });
    filteredStream.on("error", () => undefined);
    filteredStream.write(
      `# ${adoptedAt} manager restarted; adopted running pid=${pid} (filtered log has a gap here — see raw log)\n`,
    );

    const runtime: WebappRuntime = {
      name,
      runId: run.id,
      adopted: true,
      child: null,
      filteredStream,
      tail: null,
      exitWaiters: [],
      pendingStopReason: null,
      pid,
      status: "running",
      startedAt: run.startedAt,
      stoppedAt: null,
      exitCode: null,
      logPath: run.logPath,
      rawLogPath: run.rawLogPath,
    };

    if (run.rawLogPath) {
      let tailStartOffset = 0;
      try {
        tailStartOffset = statSync(run.rawLogPath).size;
      } catch {
        tailStartOffset = 0;
      }
      runtime.tail = this.startTail(runtime, run.rawLogPath, tailStartOffset);
    }

    runtime.adoptedExitPoll = setInterval(() => {
      if (this.isTerminal(runtime) || !runtime.pid) {
        return;
      }
      if (isPidAlive(runtime.pid)) {
        return;
      }
      const requested = runtime.status === "stopping";
      this.finalizeExit(runtime, {
        status: requested ? "exited" : "error",
        exitCode: null,
        marker: requested
          ? "EXIT adopted process stopped"
          : "ERROR adopted process died unexpectedly",
      });
    }, ADOPTED_EXIT_POLL_INTERVAL_MS);
    runtime.adoptedExitPoll.unref();

    this.processes.set(name, runtime);
    updateWebappRun(run.id, {
      pid,
      status: "running",
      adopted: true,
      stopReason: null,
    });

    return this.getState(name)!;
  }

  stop(
    name: string,
    reason: WebappStopReason,
    timeoutMs = 10_000,
  ): WebappRuntimeState | null {
    const runtime = this.processes.get(name);
    if (!runtime) {
      return null;
    }
    this.requestStop(runtime, timeoutMs, reason);
    return this.getState(name)!;
  }

  async waitForStopped(name: string, timeoutMs: number): Promise<boolean> {
    const runtime = this.processes.get(name);
    if (!runtime) {
      return true;
    }
    return this.waitForExit(runtime, timeoutMs);
  }

  async shutdownAll(
    timeoutMs = 10_000,
  ): Promise<WebappSupervisorShutdownResult> {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
    const result: WebappSupervisorShutdownResult = {
      requested: 0,
      stopped: 0,
      forced: 0,
      skipped: 0,
    };
    await Promise.all(
      [...this.processes.values()].map(async (runtime) => {
        if (this.isTerminal(runtime)) {
          result.skipped += 1;
          return;
        }
        result.requested += 1;
        this.requestStop(runtime, effectiveTimeoutMs, "shutdown");
        if (await this.waitForExit(runtime, effectiveTimeoutMs)) {
          result.stopped += 1;
          return;
        }
        this.killRuntime(runtime, "SIGKILL");
        result.forced += 1;
        await this.waitForExit(runtime, 1_000);
      }),
    );
    return result;
  }

  private startTail(
    runtime: WebappRuntime,
    rawLogPath: string,
    startOffset: number,
  ) {
    const tail = new RawLogTail({
      path: rawLogPath,
      startOffset,
      onLines: (chunk) => {
        const filtered = config.logs.filterRoutineProbeRequests
          ? filterRoutineProbeLogChunk(chunk, undefined, "uvicorn")
          : chunk;
        if (filtered) {
          this.writeFiltered(runtime, filtered);
        }
      },
    });
    tail.start();
    return tail;
  }

  private isTerminal(runtime: WebappRuntime) {
    return runtime.status === "exited" || runtime.status === "error";
  }

  private killRuntime(runtime: WebappRuntime, signal: NodeJS.Signals) {
    try {
      if (!runtime.pid) return;
      process.kill(
        process.platform === "win32" ? runtime.pid : -runtime.pid,
        signal,
      );
    } catch {
      try {
        runtime.child?.kill(signal);
      } catch {}
    }
  }

  private requestStop(
    runtime: WebappRuntime,
    timeoutMs: number,
    reason: WebappStopReason,
  ) {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
    if (this.isTerminal(runtime)) {
      return;
    }

    if (runtime.status !== "stopping") {
      runtime.status = "stopping";
      runtime.pendingStopReason = reason;
      updateWebappRun(runtime.runId, {
        status: "stopping",
        stopReason: reason,
      });
      this.killRuntime(runtime, "SIGTERM");
    }

    if (!runtime.forceKillTimer) {
      runtime.forceKillTimer = setTimeout(() => {
        if (runtime.status === "stopping") {
          this.killRuntime(runtime, "SIGKILL");
        }
      }, effectiveTimeoutMs);
      runtime.forceKillTimer.unref();
    }
  }

  private finalizeExit(
    runtime: WebappRuntime,
    input: {
      status: "exited" | "error";
      exitCode: number | null;
      marker: string;
    },
  ) {
    if (this.isTerminal(runtime)) {
      return;
    }
    if (runtime.forceKillTimer) {
      clearTimeout(runtime.forceKillTimer);
      delete runtime.forceKillTimer;
    }
    if (runtime.adoptedExitPoll) {
      clearInterval(runtime.adoptedExitPoll);
      delete runtime.adoptedExitPoll;
    }
    const stopReason: WebappStopReason | null =
      runtime.status === "stopping" ? runtime.pendingStopReason : "crash";
    runtime.status = input.status;
    runtime.exitCode = input.exitCode;
    runtime.stoppedAt = nowIso();
    runtime.pid = null;
    updateWebappRun(runtime.runId, {
      pid: null,
      status: input.status,
      stoppedAt: runtime.stoppedAt,
      exitCode: input.exitCode,
      stopReason,
    });
    this.writeMarker(runtime, `${runtime.stoppedAt} ${input.marker}\n`);
    for (const waiter of runtime.exitWaiters.splice(0)) {
      waiter();
    }
    void this.closeLogs(runtime);
  }

  private async closeLogs(runtime: WebappRuntime) {
    await runtime.tail?.stop();
    if (!runtime.filteredStream.writableEnded) {
      runtime.filteredStream.end();
    }
  }

  private writeMarker(runtime: WebappRuntime, line: string) {
    if (runtime.rawLogPath) {
      try {
        appendFileSync(runtime.rawLogPath, line);
        return;
      } catch {
        this.writeFiltered(runtime, line);
        return;
      }
    }
    this.writeFiltered(runtime, line);
  }

  private writeFiltered(runtime: WebappRuntime, message: string) {
    const stream = runtime.filteredStream;
    if (stream.writableEnded || stream.destroyed) {
      return;
    }
    stream.write(message);
  }

  private waitForExit(runtime: WebappRuntime, timeoutMs: number) {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
    if (this.isTerminal(runtime)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolveDone) => {
      const waiter = () => {
        clearTimeout(timer);
        resolveDone(true);
      };
      const timer = setTimeout(() => {
        const index = runtime.exitWaiters.indexOf(waiter);
        if (index !== -1) {
          runtime.exitWaiters.splice(index, 1);
        }
        resolveDone(false);
      }, effectiveTimeoutMs);
      runtime.exitWaiters.push(waiter);
    });
  }
}

export const webappSupervisor = new WebappSupervisor();
