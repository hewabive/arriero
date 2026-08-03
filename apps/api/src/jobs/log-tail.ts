import { readTailLines } from "../utils/log-tail.js";

export type JobLogTail = {
  jobId: string;
  logPath: string | null;
  lines: string[];
  truncated: boolean;
};

export function tailJobLog(
  jobId: string,
  job: { logPath: string } | null,
  lines: number,
): JobLogTail {
  const requestedLines = Math.max(1, Math.min(lines, 1_000));
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
