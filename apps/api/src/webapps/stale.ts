import type { WebappStopReason } from "@arriero/core";

import { isPidAlive, parsePidText } from "../process/pid.js";
import { escalateStaleStop } from "../process/stale.js";
import {
  listOpenWebappRuns,
  updateWebappRun,
  type WebappRun,
} from "./runs-repository.js";

function liveStaleWebappRun(
  name: string,
): { run: WebappRun; pid: number } | null {
  for (const run of listOpenWebappRuns()) {
    const pid = parsePidText(run.pid);
    if (
      run.webappId === name &&
      run.status === "stale" &&
      pid &&
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

  const stoppedAt = await escalateStaleStop({
    pid,
    timeoutMs,
    markStopping: () =>
      updateWebappRun(run.id, { status: "stopping", stopReason: reason }),
    markStale: () =>
      updateWebappRun(run.id, { status: "stale", stopReason: null }),
    label: "webapp process",
  });

  updateWebappRun(run.id, {
    pid: null,
    status: "exited",
    stoppedAt,
    exitCode: null,
    stopReason: reason,
  });
  return true;
}
