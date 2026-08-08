import type { RuntimeState } from "@arriero/core";

import { isPidAlive } from "./pid.js";
import {
  listOpenProcessRuns,
  type ProcessRun,
  updateProcessRun,
} from "./runs-repository.js";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export function liveStaleProcessRun(
  instanceId: string,
): { run: ProcessRun; pid: number } | null {
  for (const run of listOpenProcessRuns()) {
    const pid = run.pid ? Number(run.pid) : null;
    if (
      run.instanceId === instanceId &&
      run.status === "stale" &&
      pid &&
      Number.isFinite(pid) &&
      isPidAlive(pid)
    ) {
      return { run, pid };
    }
  }
  return null;
}

export async function stopStaleProcess(
  instanceId: string,
  timeoutMs = 5_000,
): Promise<RuntimeState | null> {
  const stale = liveStaleProcessRun(instanceId);
  if (!stale) {
    return null;
  }
  const { run, pid } = stale;

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new Error((error as Error).message);
  }

  updateProcessRun(run.id, { status: "stopping" });

  if (!(await waitForExit(pid, timeoutMs))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    if (!(await waitForExit(pid, 1_000))) {
      updateProcessRun(run.id, { status: "stale" });
      throw new Error(`unable to stop stale process pid=${pid}`);
    }
  }

  const stoppedAt = nowIso();
  updateProcessRun(run.id, {
    pid: null,
    status: "exited",
    stoppedAt,
    exitCode: null,
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
