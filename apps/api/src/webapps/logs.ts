import type { WebappLogTail } from "@arriero/core";

import { readTailLines } from "../utils/log-tail.js";
import { latestWebappRun } from "./runs-repository.js";
import type { WebappRuntimeState } from "./supervisor.js";

export function tailWebappLog(input: {
  name: string;
  runtime: WebappRuntimeState | undefined;
  lines: number;
  source?: "filtered" | "raw";
}): WebappLogTail {
  const requestedLines = Math.max(1, Math.min(input.lines, 1_000));
  const latestRun = latestWebappRun(input.name);
  const filteredLogPath = input.runtime?.logPath ?? latestRun?.logPath ?? null;
  const rawLogPath = input.runtime?.rawLogPath ?? latestRun?.rawLogPath ?? null;
  const logPath =
    input.source === "raw" ? (rawLogPath ?? filteredLogPath) : filteredLogPath;

  if (!logPath) {
    return {
      name: input.name,
      logPath: null,
      rawLogPath,
      lines: [],
      truncated: false,
    };
  }

  try {
    const tail = readTailLines(logPath, requestedLines);
    return {
      name: input.name,
      logPath,
      rawLogPath,
      lines: tail.lines,
      truncated: tail.truncated,
    };
  } catch (error) {
    return {
      name: input.name,
      logPath,
      rawLogPath,
      lines: [`Unable to read log file: ${(error as Error).message}`],
      truncated: false,
    };
  }
}
