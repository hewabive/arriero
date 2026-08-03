import type { EnvironmentLogTail } from "@arriero/core";

import { tailJobLog } from "../jobs/log-tail.js";
import { getEnvironmentJob } from "./repository.js";

export function tailEnvironmentLog(
  jobId: string,
  lines: number,
): EnvironmentLogTail {
  return tailJobLog(jobId, getEnvironmentJob(jobId), lines);
}
