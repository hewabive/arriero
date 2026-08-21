import { isPidAlive } from "./pid.js";
import { listOpenProcessRuns, type ProcessRun } from "./runs-repository.js";

export type LiveOpenProcessRun = { run: ProcessRun; pid: number };

export function listLiveOpenProcessRuns(): LiveOpenProcessRun[] {
  return listOpenProcessRuns().flatMap((run) => {
    const pid = run.pid ? Number(run.pid) : null;
    return pid && Number.isFinite(pid) && isPidAlive(pid) ? [{ run, pid }] : [];
  });
}
