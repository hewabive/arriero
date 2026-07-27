import type { BuildLogTail } from "@arriero/core";

import { getBuildJob } from "./repository.js";
import { readTailLines } from "../utils/log-tail.js";

export function tailBuildLog(jobId: string, lines: number): BuildLogTail {
  const requestedLines = Math.max(1, Math.min(lines, 1_000));
  const job = getBuildJob(jobId);

  if (!job) {
    return {
      jobId,
      logPath: null,
      lines: [],
      truncated: false,
    };
  }

  try {
    const tail = readTailLines(job.logPath, requestedLines);
    return {
      jobId,
      logPath: job.logPath,
      lines: tail.lines,
      truncated: tail.truncated,
    };
  } catch (error) {
    return {
      jobId,
      logPath: job.logPath,
      lines: [`Unable to read log file: ${(error as Error).message}`],
      truncated: false,
    };
  }
}
