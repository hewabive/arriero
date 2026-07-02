import { readTailLines } from "../utils/log-tail.js";
import type { UpdateLogTail } from "./adapter.js";
import { getUpdateJob } from "./repository.js";

export function tailUpdateLog(jobId: string, lines: number): UpdateLogTail {
  const requestedLines = Math.max(1, Math.min(lines, 1_000));
  const job = getUpdateJob(jobId);
  if (!job) {
    return { jobId, logPath: null, lines: [], truncated: false };
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
