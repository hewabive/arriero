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
  for (const line of [...lines].reverse()) {
    if (
      /captur(?:e|ing|ed).*cuda graphs?|cuda graphs?.*captur|graph capturing/i.test(
        line,
      )
    ) {
      return loadProgress("warmup", 95, "vLLM is capturing CUDA graphs.");
    }
    if (/torch\.compile|AOT compiled|compil(?:e|ing).*graph/i.test(line)) {
      return loadProgress("warmup", 90, "vLLM is compiling model graphs.");
    }
    if (
      /available KV cache memory|GPU KV cache size|KV cache.*tokens/i.test(line)
    ) {
      return loadProgress("context", 85, "vLLM is initializing the KV cache.");
    }
    const percentLine = /(?:loading|loaded).*?(\d{1,3}(?:\.\d+)?)%/i.exec(line);
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
    if (/loading model weights|load.*weights/i.test(line)) {
      return loadProgress("tensors", null, "vLLM is loading model weights.");
    }
    if (/initializ(?:ing|e).*\b(?:V\d+ )?(?:LLM )?engine\b/i.test(line)) {
      return loadProgress("context", null, "vLLM engine is initializing.");
    }
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

function modelAlias(line: string) {
  const value =
    /['"]served_model_name['"]\s*:\s*\[\s*['"]([^'"]+)['"]/i.exec(line)?.[1] ??
    /\bserved_model_name\s*=\s*['"]?([^,\]\s'"]+)/i.exec(line)?.[1] ??
    null;
  return value === "None" ? null : value;
}

function contextSize(line: string) {
  const value =
    /\bUsing max model len\s+(\d+)/i.exec(line)?.[1] ??
    /['"]max_model_len['"]\s*:\s*(\d+)/i.exec(line)?.[1] ??
    /\b(?:max_model_len|max_seq_len)\s*=\s*(\d+)/i.exec(line)?.[1] ??
    null;
  const parsed = value ? Number(value) : null;
  return parsed && parsed > 0 ? parsed : null;
}

export const vllmLogParser: EngineLogParser = {
  parse: ({ lines }) => ({
    listeningUrl:
      [...lines]
        .reverse()
        .map((line) => /(https?:\/\/[^\s]+)/i.exec(line)?.[1] ?? null)
        .find(Boolean) ?? null,
    modelPath: [...lines].reverse().map(modelPath).find(Boolean) ?? null,
    modelAlias: [...lines].reverse().map(modelAlias).find(Boolean) ?? null,
    contextSize: [...lines].reverse().map(contextSize).find(Boolean) ?? null,
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
      /Application startup complete|Started server process|loading model weights|EngineCore|torch\.compile|Available KV cache memory|GPU KV cache size|CUDA graphs?|Model Runner V2 does not yet support the thinking_token_budget/i,
      10,
    ),
    loadProgress: progress(lines),
    memoryLayout: emptyMemoryLayout(),
  }),
};
