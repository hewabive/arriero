import type {
  InstanceLoadProgress,
  InstanceLogSummary,
  InstanceMemoryLayout,
} from "@arriero/core";

export type EngineLogParseInput = {
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
