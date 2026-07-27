import type { Instance } from "@arriero/core";
import { readFileSync } from "node:fs";

import { cleanupOrphanNumaCgroups } from "../numa/index.js";
import { parseLaunchSnapshot } from "./launch-snapshot.js";
import { isPidAlive } from "./pid.js";
import { listOpenProcessRuns, updateProcessRun } from "./runs-repository.js";
import { supervisor } from "./supervisor.js";

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

export function reconcileProcessRuns(instances: Instance[]) {
  const runs = listOpenProcessRuns();
  const summary = {
    checked: runs.length,
    adopted: 0,
    stale: 0,
    exited: 0,
  };

  for (const run of runs) {
    const pid = run.pid ? Number(run.pid) : null;
    if (!pid || !Number.isFinite(pid) || !isPidAlive(pid)) {
      updateProcessRun(run.id, {
        pid: null,
        status: "exited",
        stoppedAt: nowIso(),
        exitCode: null,
      });
      summary.exited += 1;
      continue;
    }

    const instance = instances.find((entry) => entry.name === run.instanceId);
    const snapshot = parseLaunchSnapshot(run.launchSnapshot);
    const expectedBinary = snapshot?.binaryPath ?? instance?.binaryPath ?? null;
    if (
      instance &&
      expectedBinary &&
      processCommandMatchesBinary(pid, expectedBinary)
    ) {
      supervisor.adopt(instance, run, pid);
      summary.adopted += 1;
      continue;
    }

    updateProcessRun(run.id, {
      pid,
      status: "stale",
    });
    summary.stale += 1;
  }

  cleanupOrphanNumaCgroups();

  return summary;
}
