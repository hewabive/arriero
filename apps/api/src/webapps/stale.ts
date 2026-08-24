import type { WebappStopReason } from "@arriero/core";

import { isPidAlive } from "../process/pid.js";
import { sleep } from "../utils/sleep.js";
import {
  listOpenWebappRuns,
  updateWebappRun,
  type WebappRun,
} from "./runs-repository.js";

function nowIso() {
  return new Date().toISOString();
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

function liveStaleWebappRun(
  name: string,
): { run: WebappRun; pid: number } | null {
  for (const run of listOpenWebappRuns()) {
    const pid = run.pid ? Number(run.pid) : null;
    if (
      run.webappId === name &&
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

export async function stopStaleWebapp(
  name: string,
  reason: WebappStopReason,
  timeoutMs = 5_000,
): Promise<boolean> {
  const stale = liveStaleWebappRun(name);
  if (!stale) {
    return false;
  }
  const { run, pid } = stale;

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new Error((error as Error).message);
  }

  updateWebappRun(run.id, { status: "stopping", stopReason: reason });

  if (!(await waitForExit(pid, timeoutMs))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    if (!(await waitForExit(pid, 1_000))) {
      updateWebappRun(run.id, { status: "stale", stopReason: null });
      throw new Error(`unable to stop stale webapp process pid=${pid}`);
    }
  }

  updateWebappRun(run.id, {
    pid: null,
    status: "exited",
    stoppedAt: nowIso(),
    exitCode: null,
    stopReason: reason,
  });
  return true;
}
