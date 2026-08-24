import { readFileSync } from "node:fs";

import { isPidAlive } from "../process/pid.js";
import { listWebappRecords } from "./config-files.js";
import { parseWebappLaunchSnapshot } from "./launch.js";
import { listOpenWebappRuns, updateWebappRun } from "./runs-repository.js";
import { webappSupervisor } from "./supervisor.js";

function nowIso() {
  return new Date().toISOString();
}

function processCommandMatchesBinary(pid: number, binaryPath: string) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    return argv.includes(binaryPath);
  } catch {
    return false;
  }
}

export function reconcileWebappRuns(quarantinedWebappNames?: Set<string>) {
  const records = listWebappRecords();
  const runs = listOpenWebappRuns();
  const summary = {
    checked: runs.length,
    adopted: 0,
    stale: 0,
    exited: 0,
    deferred: 0,
  };

  for (const run of runs) {
    const pid = run.pid ? Number(run.pid) : null;
    if (!pid || !Number.isFinite(pid) || !isPidAlive(pid)) {
      updateWebappRun(run.id, {
        pid: null,
        status: "exited",
        stoppedAt: nowIso(),
        exitCode: null,
        stopReason: run.stopReason ?? "crash",
      });
      summary.exited += 1;
      continue;
    }

    const snapshot = parseWebappLaunchSnapshot(run.launchSnapshot);
    if (
      quarantinedWebappNames?.has(run.webappId) &&
      snapshot?.binaryPath &&
      processCommandMatchesBinary(pid, snapshot.binaryPath)
    ) {
      summary.deferred += 1;
      continue;
    }
    const record = records.find((entry) => entry.name === run.webappId);
    if (
      record &&
      snapshot?.binaryPath &&
      processCommandMatchesBinary(pid, snapshot.binaryPath)
    ) {
      webappSupervisor.adopt(record.name, run, pid);
      summary.adopted += 1;
      continue;
    }

    updateWebappRun(run.id, {
      pid,
      status: "stale",
    });
    summary.stale += 1;
  }

  return summary;
}
