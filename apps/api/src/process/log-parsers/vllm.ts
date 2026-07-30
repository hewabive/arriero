import {
  emptyMemoryLayout,
  loadProgress,
  type EngineLogParser,
} from "./types.js";

const READY = /Application startup complete\.|Started server process \[\d+\]/i;
const ERROR =
  /\b(?:ERROR|FATAL|Exception|Traceback)\b|(?:^|\)\s)(?:[\w.]+(?:Error|Exception)):\s+\S/;
const WARNING = /\b(?:WARN|WARNING)\b/;
const CAPABILITY_NOTICE =
  /Model Runner V2 does not yet support the thinking_token_budget request parameter\./;

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
    const percent = Math.max(
      1,
      Math.min(95, Math.round(Number(percentLine[1]))),
    );
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

function modelPath(line: string) {
  return (
    /\bmodel\s{2,}([^\s]+)\s*$/.exec(line)?.[1] ??
    /\bmodel=['"]([^'"]+)['"]/.exec(line)?.[1] ??
    /['"]model['"]:\s*['"]([^'"]+)['"]/.exec(line)?.[1] ??
    null
  );
}

export const vllmLogParser: EngineLogParser = {
  parse: ({ lines }) => ({
    listeningUrl:
      [...lines]
        .reverse()
        .map((line) => /(https?:\/\/[^\s]+)/i.exec(line)?.[1] ?? null)
        .find(Boolean) ?? null,
    modelPath: [...lines].reverse().map(modelPath).find(Boolean) ?? null,
    modelAlias: null,
    contextSize: null,
    gpuLayers: null,
    slots: null,
    ready: lines.some((line) => READY.test(line)),
    warnings: tailMatches(
      lines.filter((line) => !CAPABILITY_NOTICE.test(line)),
      WARNING,
      8,
    ),
    errors: tailMatches(lines, ERROR, 8),
    notices: tailMatches(
      lines,
      /Application startup complete|Started server process|loading model weights|EngineCore|Model Runner V2 does not yet support the thinking_token_budget/i,
      10,
    ),
    loadProgress: progress(lines),
    memoryLayout: emptyMemoryLayout(),
  }),
};
