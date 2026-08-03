import type { BuildLogTail } from "@arriero/core";

import { tailJobLog } from "../jobs/log-tail.js";
import { getBuildJob } from "./repository.js";

export function tailBuildLog(jobId: string, lines: number): BuildLogTail {
  return tailJobLog(jobId, getBuildJob(jobId), lines);
}
