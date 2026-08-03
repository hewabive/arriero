import { tailJobLog } from "../jobs/log-tail.js";
import type { UpdateLogTail } from "./adapter.js";
import { getUpdateJob } from "./repository.js";

export function tailUpdateLog(jobId: string, lines: number): UpdateLogTail {
  return tailJobLog(jobId, getUpdateJob(jobId), lines);
}
