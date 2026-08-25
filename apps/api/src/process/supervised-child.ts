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
import {
  filterRoutineProbeLogChunk,
  type ProbeRequestLogGrammar,
} from "./log-filter.js";
import { isPidAlive } from "./pid.js";
import { RawLogTail } from "./raw-log-tail.js";

const ADOPTED_EXIT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export type SupervisedRunStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "error";

const TERMINAL_STATUSES: readonly SupervisedRunStatus[] = [
  "stopped",
  "exited",
  "error",
];

export type SupervisedChildState = {
  pid: number | null;
  status: SupervisedRunStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  logPath: string | null;
  rawLogPath: string | null;
  adopted: boolean;
};

type SupervisedRunPatch<TReason extends string> = {
  pid?: number | null;
  status?: SupervisedRunStatus;
  stoppedAt?: string | null;
  exitCode?: number | null;
  adopted?: boolean;
  stopReason?: TReason | "crash" | null;
};

export type SupervisedChildEventType = "status" | "log" | "exit" | "error";

export type SupervisedChildOptions<TReason extends string> = {
  logLabel: string;
  logGrammar: ProbeRequestLogGrammar;
  updateRun: (runId: string, patch: SupervisedRunPatch<TReason>) => void;
  signalPid?: (pid: number) => number;
  onEvent?: (type: SupervisedChildEventType, message: string) => void;
  onFinalized?: () => void;
};

export type SupervisedLaunchPlan = {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  rawLogPath: string;
};

export type SupervisedAdoptedRun = {
  runId: string;
  pid: number;
  startedAt: string;
  logPath: string;
  rawLogPath: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function defaultSignalPid(pid: number) {
  return process.platform === "win32" ? pid : -pid;
}

export class SupervisedChild<TReason extends string> {
  private runId = "";
  private child: ChildProcess | null = null;
  private filteredStream: WriteStream | null = null;
  private tail: RawLogTail | null = null;
  private readonly exitWaiters: Array<() => void> = [];
  private pendingStopReason: TReason | null = null;
  private forceKillTimer: NodeJS.Timeout | null = null;
  private adoptedExitPoll: NodeJS.Timeout | null = null;

  private pid: number | null = null;
  private status: SupervisedRunStatus = "stopped";
  private startedAt: string | null = null;
  private stoppedAt: string | null = null;
  private exitCode: number | null = null;
  private logPath: string | null = null;
  private rawLogPath: string | null = null;
  private adopted = false;

  constructor(private readonly options: SupervisedChildOptions<TReason>) {}

  state(): SupervisedChildState {
    return {
      pid: this.pid,
      status: this.status,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      logPath: this.logPath,
      rawLogPath: this.rawLogPath,
      adopted: this.adopted,
    };
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.status);
  }

  launch(
    plan: SupervisedLaunchPlan,
    createRun: (input: {
      pid: number | null;
      status: "starting";
      startedAt: string;
      logPath: string;
      rawLogPath: string;
    }) => string,
  ): void {
    const startedAt = nowIso();
    const filteredStream = createWriteStream(plan.logPath, { flags: "a" });
    filteredStream.on("error", () => undefined);
    filteredStream.write(
      [
        `# arriero filtered log for ${this.options.logLabel}`,
        config.logs.filterRoutineProbeRequests
          ? "# routine diagnostic request lines and their router side-effect noise are omitted here"
          : "# probe request filtering is disabled; this log matches raw output",
        `# raw log: ${plan.rawLogPath}`,
        "",
      ].join("\n"),
    );
    appendFileSync(
      plan.rawLogPath,
      [
        `# arriero raw log for ${this.options.logLabel}`,
        `# filtered log: ${plan.logPath}`,
        "",
      ].join("\n"),
    );
    const tailStartOffset = statSync(plan.rawLogPath).size;

    const childLogFd = openSync(plan.rawLogPath, "a");
    const child = spawn(plan.binaryPath, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["ignore", childLogFd, childLogFd],
      detached: true,
    });
    closeSync(childLogFd);
    child.unref();

    this.child = child;
    this.filteredStream = filteredStream;
    this.pid = child.pid ?? null;
    this.status = "starting";
    this.startedAt = startedAt;
    this.logPath = plan.logPath;
    this.rawLogPath = plan.rawLogPath;
    this.runId = createRun({
      pid: this.pid,
      status: "starting",
      startedAt,
      logPath: plan.logPath,
      rawLogPath: plan.rawLogPath,
    });

    this.tail = this.startTail(plan.rawLogPath, tailStartOffset);
    this.emit("status", `starting pid=${this.pid ?? "unknown"}`);

    child.on("spawn", () => {
      if (this.isTerminal()) {
        return;
      }
      this.status = "running";
      this.options.updateRun(this.runId, { pid: this.pid, status: "running" });
      this.emit("status", `running pid=${this.pid ?? "unknown"}`);
    });

    child.on("error", (error) => {
      this.finalize({
        status: "error",
        exitCode: null,
        marker: `ERROR ${error.message}`,
        event: { type: "error", message: error.message },
      });
    });

    child.on("exit", (code) => {
      const requested = this.status === "stopping";
      this.finalize({
        status: requested ? "exited" : "error",
        exitCode: code,
        marker: requested
          ? `EXIT code=${code ?? "signal"}`
          : `ERROR process exited unexpectedly code=${code ?? "signal"}`,
        event: requested
          ? { type: "exit", message: `exit code=${code ?? "signal"}` }
          : {
              type: "error",
              message: `process exited unexpectedly code=${code ?? "signal"}`,
            },
      });
    });
  }

  adopt(run: SupervisedAdoptedRun): void {
    const adoptedAt = nowIso();
    const filteredStream = createWriteStream(run.logPath, { flags: "a" });
    filteredStream.on("error", () => undefined);
    filteredStream.write(
      `# ${adoptedAt} manager restarted; adopted running pid=${run.pid} (filtered log has a gap here — see raw log)\n`,
    );

    this.filteredStream = filteredStream;
    this.runId = run.runId;
    this.adopted = true;
    this.pid = run.pid;
    this.status = "running";
    this.startedAt = run.startedAt;
    this.logPath = run.logPath;
    this.rawLogPath = run.rawLogPath;

    if (run.rawLogPath) {
      let tailStartOffset = 0;
      try {
        tailStartOffset = statSync(run.rawLogPath).size;
      } catch {
        tailStartOffset = 0;
      }
      this.tail = this.startTail(run.rawLogPath, tailStartOffset);
    }

    this.adoptedExitPoll = setInterval(() => {
      if (this.isTerminal() || !this.pid) {
        return;
      }
      if (isPidAlive(this.pid)) {
        return;
      }
      const requested = this.status === "stopping";
      this.finalize({
        status: requested ? "exited" : "error",
        exitCode: null,
        marker: requested
          ? "EXIT adopted process stopped"
          : "ERROR adopted process died unexpectedly",
        event: requested
          ? { type: "exit", message: "exit adopted process" }
          : { type: "error", message: "adopted process died unexpectedly" },
      });
    }, ADOPTED_EXIT_POLL_INTERVAL_MS);
    this.adoptedExitPoll.unref();

    this.options.updateRun(run.runId, {
      pid: run.pid,
      status: "running",
      adopted: true,
      stopReason: null,
    });
    this.emit("status", `adopted pid=${run.pid}`);
  }

  requestStop(reason: TReason, timeoutMs: number): void {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_STOP_TIMEOUT_MS;
    if (this.isTerminal()) {
      return;
    }

    if (this.status !== "stopping") {
      this.status = "stopping";
      this.pendingStopReason = reason;
      this.options.updateRun(this.runId, {
        status: "stopping",
        stopReason: reason,
      });
      this.emit("status", "stopping");
      this.kill("SIGTERM");
    }

    if (!this.forceKillTimer) {
      this.forceKillTimer = setTimeout(() => {
        if (this.status === "stopping") {
          this.forceKill();
        }
      }, effectiveTimeoutMs);
      this.forceKillTimer.unref();
    }
  }

  forceKill(): void {
    if (this.isTerminal()) {
      return;
    }
    this.emit("status", "force killing");
    this.kill("SIGKILL");
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_STOP_TIMEOUT_MS;
    if (this.isTerminal()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolveDone) => {
      const waiter = () => {
        clearTimeout(timer);
        resolveDone(true);
      };
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index !== -1) {
          this.exitWaiters.splice(index, 1);
        }
        resolveDone(false);
      }, effectiveTimeoutMs);
      this.exitWaiters.push(waiter);
    });
  }

  private emit(type: SupervisedChildEventType, message: string) {
    this.options.onEvent?.(type, message);
  }

  private startTail(rawLogPath: string, startOffset: number) {
    const tail = new RawLogTail({
      path: rawLogPath,
      startOffset,
      onLines: (chunk) => {
        const filtered = config.logs.filterRoutineProbeRequests
          ? filterRoutineProbeLogChunk(
              chunk,
              undefined,
              this.options.logGrammar,
            )
          : chunk;
        if (filtered) {
          this.writeFiltered(filtered);
        }
        this.emit("log", chunk);
      },
    });
    tail.start();
    return tail;
  }

  private kill(signal: NodeJS.Signals) {
    try {
      if (!this.pid) return;
      process.kill(
        (this.options.signalPid ?? defaultSignalPid)(this.pid),
        signal,
      );
    } catch {
      try {
        this.child?.kill(signal);
      } catch {}
    }
  }

  private finalize(input: {
    status: "exited" | "error";
    exitCode: number | null;
    marker: string;
    event: { type: "exit" | "error"; message: string };
  }) {
    if (this.isTerminal()) {
      return;
    }
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
    if (this.adoptedExitPoll) {
      clearInterval(this.adoptedExitPoll);
      this.adoptedExitPoll = null;
    }
    const stopReason: TReason | "crash" | null =
      this.status === "stopping" ? this.pendingStopReason : "crash";
    this.status = input.status;
    this.exitCode = input.exitCode;
    this.stoppedAt = nowIso();
    this.pid = null;
    this.options.updateRun(this.runId, {
      pid: null,
      status: input.status,
      stoppedAt: this.stoppedAt,
      exitCode: input.exitCode,
      stopReason,
    });
    this.writeMarker(`${this.stoppedAt} ${input.marker}\n`);
    this.emit(input.event.type, input.event.message);
    this.options.onFinalized?.();
    for (const waiter of this.exitWaiters.splice(0)) {
      waiter();
    }
    void this.closeLogs();
  }

  private async closeLogs() {
    await this.tail?.stop();
    if (this.filteredStream && !this.filteredStream.writableEnded) {
      this.filteredStream.end();
    }
  }

  private writeMarker(line: string) {
    if (this.rawLogPath) {
      try {
        appendFileSync(this.rawLogPath, line);
        return;
      } catch {
        this.writeFiltered(line);
        return;
      }
    }
    this.writeFiltered(line);
  }

  private writeFiltered(message: string) {
    const stream = this.filteredStream;
    if (!stream || stream.writableEnded || stream.destroyed) {
      return;
    }
    stream.write(message);
  }
}

export type SupervisedShutdownResult = {
  requested: number;
  stopped: number;
  forced: number;
  skipped: number;
};

export async function shutdownSupervisedChildren<TReason extends string>(
  children: Iterable<SupervisedChild<TReason>>,
  reason: TReason,
  timeoutMs: number,
): Promise<SupervisedShutdownResult> {
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_STOP_TIMEOUT_MS;
  const result: SupervisedShutdownResult = {
    requested: 0,
    stopped: 0,
    forced: 0,
    skipped: 0,
  };
  await Promise.all(
    [...children].map(async (child) => {
      if (child.isTerminal()) {
        result.skipped += 1;
        return;
      }
      result.requested += 1;
      child.requestStop(reason, effectiveTimeoutMs);
      if (await child.waitForExit(effectiveTimeoutMs)) {
        result.stopped += 1;
        return;
      }
      child.forceKill();
      result.forced += 1;
      await child.waitForExit(1_000);
    }),
  );
  return result;
}
