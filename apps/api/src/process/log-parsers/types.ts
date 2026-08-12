import type {
  InstanceLoadProgress,
  InstanceLogSummary,
  InstanceMemoryLayout,
} from "@arriero/core";

type EngineLogParseInput = {
  lines: string[];
  cudaDevicesDisabled: boolean;
};

export type EngineLogParseResult = Pick<
  InstanceLogSummary,
  | "listeningUrl"
  | "modelPath"
  | "modelAlias"
  | "contextSize"
  | "gpuLayers"
  | "slots"
  | "ready"
  | "warnings"
  | "errors"
  | "notices"
  | "loadProgress"
  | "memoryLayout"
>;

export type EngineLogParser = {
  parse: (input: EngineLogParseInput) => EngineLogParseResult;
};

export const PYTHON_TRACEBACK_START = /^Traceback \(most recent call last\):/;
export const PYTHON_EXCEPTION_START = /^[\w.]+(?:Error|Exception)(?::\s|$)/;

export type LogLineLevel = "error" | "warning";

export function classifiedTails(
  lines: string[],
  classify: (line: string) => LogLineLevel | null,
  limit: number,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const level = classify(line);
    if (level === "error") {
      errors.push(line.trim());
    } else if (level === "warning") {
      warnings.push(line.trim());
    }
  }
  return { errors: errors.slice(-limit), warnings: warnings.slice(-limit) };
}

export function tailMatches(lines: string[], pattern: RegExp, limit: number) {
  return lines
    .filter((line) => pattern.test(line))
    .map((line) => line.trim())
    .slice(-limit);
}

export function loadProgress(
  stage: InstanceLoadProgress["stage"],
  percent: number | null,
  message: string,
  estimated = true,
): InstanceLoadProgress {
  return { stage, percent, message, estimated };
}

export function pendingLoadProgress(): InstanceLoadProgress {
  return loadProgress("pending", null, "Waiting for model loading log lines.");
}

export function emptyMemoryLayout(): InstanceMemoryLayout {
  return {
    source: "none",
    sourceDetail: null,
    processIds: [],
    entries: [],
    deviceBytes: 0,
    hostBytes: 0,
    otherBytes: 0,
    totalBytes: 0,
    projectedHostBytes: null,
    projectedHostTotalBytes: null,
  };
}
