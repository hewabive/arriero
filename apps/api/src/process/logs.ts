import type { LogTail, RuntimeState } from "@arriero/core";

import { latestProcessRun } from "./runs-repository.js";
import { readTailLines } from "../utils/log-tail.js";

export function tailInstanceLog(input: {
  instanceId: string;
  runtime: RuntimeState | undefined;
  lines: number;
  source?: "filtered" | "raw";
}): LogTail {
  const requestedLines = Math.max(1, Math.min(input.lines, 1_000));
  const latestRun = latestProcessRun(input.instanceId);
  const filteredLogPath = input.runtime?.logPath ?? latestRun?.logPath ?? null;
  const rawLogPath = input.runtime?.rawLogPath ?? latestRun?.rawLogPath ?? null;
  const logPath =
    input.source === "raw" ? (rawLogPath ?? filteredLogPath) : filteredLogPath;

  if (!logPath) {
    return {
      instanceId: input.instanceId,
      logPath: null,
      rawLogPath,
      lines: [],
      truncated: false,
    };
  }

  try {
    const tail = readTailLines(logPath, requestedLines);
    return {
      instanceId: input.instanceId,
      logPath,
      rawLogPath,
      lines: tail.lines,
      truncated: tail.truncated,
    };
  } catch (error) {
    return {
      instanceId: input.instanceId,
      logPath,
      rawLogPath,
      lines: [`Unable to read log file: ${(error as Error).message}`],
      truncated: false,
    };
  }
}
