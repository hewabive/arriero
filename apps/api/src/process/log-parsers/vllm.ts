import { emptyMemoryLayout, loadProgress, type EngineLogParser } from "./types.js";

const READY = /Application startup complete\.|Started server process \[\d+\]/i;
const ERROR = /\b(error|fatal|failed|exception|traceback)\b/i;
const WARNING = /\b(warn|warning)\b/i;

function tailMatches(lines: string[], pattern: RegExp, limit: number) {
  return lines
    .filter((line) => pattern.test(line))
    .map((line) => line.trim())
    .slice(-limit);
}

function progress(lines: string[]) {
  if (lines.some((line) => READY.test(line))) {
    return loadProgress("ready", 100, "vLLM API server is ready.", false);
  }
  const error = [...lines].reverse().find((line) => ERROR.test(line));
  if (error) {
    return loadProgress("error", null, error.trim(), false);
  }
  const percentLine = [...lines]
    .reverse()
    .map((line) => /(?:loading|loaded).*?(\d{1,3}(?:\.\d+)?)%/i.exec(line))
    .find(Boolean);
  if (percentLine?.[1]) {
    const percent = Math.max(1, Math.min(95, Math.round(Number(percentLine[1]))));
    return loadProgress(
      "tensors",
      percent,
      "vLLM is loading model weights.",
      true,
    );
  }
  if (lines.some((line) => /loading model weights|load.*weights/i.test(line))) {
    return loadProgress("tensors", null, "vLLM is loading model weights.");
  }
  if (lines.some((line) => /EngineCore|initializ/i.test(line))) {
    return loadProgress("context", null, "vLLM engine is initializing.");
  }
  return loadProgress("starting", 5, "Starting the vLLM API server.");
}

export const vllmLogParser: EngineLogParser = {
  parse: ({ lines }) => ({
    listeningUrl:
      [...lines]
        .reverse()
        .map((line) => /(https?:\/\/[^\s]+)/i.exec(line)?.[1] ?? null)
        .find(Boolean) ?? null,
    modelPath:
      [...lines]
        .reverse()
        .map(
          (line) =>
            /(?:model|served model)[^:=]*[:=]\s*["']?([^\s,"']+)/i.exec(line)?.[1] ??
            null,
        )
        .find(Boolean) ?? null,
    modelAlias: null,
    contextSize: null,
    gpuLayers: null,
    slots: null,
    ready: lines.some((line) => READY.test(line)),
    warnings: tailMatches(lines, WARNING, 8),
    errors: tailMatches(lines, ERROR, 8),
    notices: tailMatches(
      lines,
      /Application startup complete|Started server process|loading model weights|EngineCore/i,
      10,
    ),
    loadProgress: progress(lines),
    memoryLayout: emptyMemoryLayout(),
  }),
};
