import type { LogTail, RuntimeState } from "@arriero/core";

import { latestProcessRun } from "./runs-repository.js";
import { readTailLines } from "../utils/log-tail.js";

type RunLogPaths = { logPath: string | null; rawLogPath: string | null };

export function tailRunLog(input: {
  runtime: RunLogPaths | undefined;
  latestRun: () => RunLogPaths | null;
  lines: number;
  source?: "filtered" | "raw" | undefined;
}): { logPath: string | null; rawLogPath: string | null } & Pick<
  LogTail,
  "lines" | "truncated"
> {
  const requestedLines = Math.max(1, Math.min(input.lines, 1_000));
  const latestRun =
    input.runtime?.logPath != null && input.runtime.rawLogPath != null
      ? null
      : input.latestRun();
  const filteredLogPath = input.runtime?.logPath ?? latestRun?.logPath ?? null;
  const rawLogPath = input.runtime?.rawLogPath ?? latestRun?.rawLogPath ?? null;
  const logPath =
    input.source === "raw" ? (rawLogPath ?? filteredLogPath) : filteredLogPath;

  if (!logPath) {
    return { logPath: null, rawLogPath, lines: [], truncated: false };
  }

  try {
    const tail = readTailLines(logPath, requestedLines);
    return {
      logPath,
      rawLogPath,
      lines: tail.lines,
      truncated: tail.truncated,
    };
  } catch (error) {
    return {
      logPath,
      rawLogPath,
      lines: [`Unable to read log file: ${(error as Error).message}`],
      truncated: false,
    };
  }
}

export function tailInstanceLog(input: {
  instanceId: string;
  runtime: RuntimeState | undefined;
  lines: number;
  source?: "filtered" | "raw" | undefined;
}): LogTail {
  return {
    instanceId: input.instanceId,
    ...tailRunLog({
      runtime: input.runtime,
      latestRun: () => latestProcessRun(input.instanceId),
      lines: input.lines,
      source: input.source,
    }),
  };
}
