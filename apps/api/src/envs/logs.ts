import type { EnvironmentLogTail } from "@llama-manager/core";

import { readTailLines } from "../utils/log-tail.js";
import { getEnvironmentJob } from "./repository.js";

export function tailEnvironmentLog(jobId: string, lines: number): EnvironmentLogTail {
  const requested = Math.max(1, Math.min(lines, 1_000));
  const job = getEnvironmentJob(jobId);
  if (!job) return { jobId, logPath: null, lines: [], truncated: false };
  try {
    const tail = readTailLines(job.logPath, requested);
    return { jobId, logPath: job.logPath, ...tail };
  } catch (error) {
    return {
      jobId,
      logPath: job.logPath,
      lines: [`Unable to read log file: ${(error as Error).message}`],
      truncated: false,
    };
  }
}
