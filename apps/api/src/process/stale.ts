import type { RuntimeState } from "@arriero/core";

import { sleep } from "../utils/sleep.js";
import { isPidAlive, parsePidText } from "./pid.js";
import {
  listOpenProcessRuns,
  type ProcessRun,
  type ProcessStopReason,
  updateProcessRun,
} from "./runs-repository.js";

async function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isPidAlive(pid);
}

export async function escalateStaleStop(input: {
  pid: number;
  timeoutMs: number;
  markStopping: () => void;
  markStale: () => void;
  label: string;
}): Promise<string> {
  process.kill(input.pid, "SIGTERM");
  input.markStopping();

  if (!(await waitForExit(input.pid, input.timeoutMs))) {
    try {
      process.kill(input.pid, "SIGKILL");
    } catch {}
    if (!(await waitForExit(input.pid, 1_000))) {
      input.markStale();
      throw new Error(`unable to stop stale ${input.label} pid=${input.pid}`);
    }
  }

  return new Date().toISOString();
}

export function liveStaleProcessRun(
  instanceId: string,
): { run: ProcessRun; pid: number } | null {
  for (const run of listOpenProcessRuns()) {
    const pid = parsePidText(run.pid);
    if (
      run.instanceId === instanceId &&
      run.status === "stale" &&
      pid &&
      isPidAlive(pid)
    ) {
      return { run, pid };
    }
  }
  return null;
}

export async function stopStaleProcess(
  instanceId: string,
  reason: ProcessStopReason,
  timeoutMs = 5_000,
): Promise<RuntimeState | null> {
  const stale = liveStaleProcessRun(instanceId);
  if (!stale) {
    return null;
  }
  const { run, pid } = stale;

  const stoppedAt = await escalateStaleStop({
    pid,
    timeoutMs,
    markStopping: () =>
      updateProcessRun(run.id, { status: "stopping", stopReason: reason }),
    markStale: () =>
      updateProcessRun(run.id, { status: "stale", stopReason: null }),
    label: "process",
  });

  updateProcessRun(run.id, {
    pid: null,
    status: "exited",
    stoppedAt,
    exitCode: null,
    stopReason: reason,
  });

  return {
    instanceId,
    pid: null,
    status: "exited",
    startedAt: run.startedAt,
    stoppedAt,
    exitCode: null,
    logPath: run.logPath,
    rawLogPath: run.rawLogPath,
  };
}
