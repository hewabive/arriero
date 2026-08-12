import {
  classifiedTails,
  emptyMemoryLayout,
  loadProgress,
  PYTHON_EXCEPTION_START,
  PYTHON_TRACEBACK_START,
  tailMatches,
  type EngineLogParser,
  type LogLineLevel,
} from "./types.js";

const READY = /Application startup complete\.|Started server process \[\d+\]/i;
const PROCESS_PREFIX = /^\([^)]*\bpid=\d+\)\s+/;
const ERROR_RECORD_STARTS = [
  /^(?:ERROR|CRITICAL|FATAL)\b/,
  PYTHON_TRACEBACK_START,
  PYTHON_EXCEPTION_START,
];
const WARNING_RECORD_START = /^WARNING\b/;
const CAPABILITY_NOTICE =
  /Model Runner V2 does not yet support the thinking_token_budget request parameter\./;

function recordOf(line: string) {
  return line.replace(PROCESS_PREFIX, "");
}

function classify(line: string): LogLineLevel | null {
  const record = recordOf(line);
  if (ERROR_RECORD_STARTS.some((pattern) => pattern.test(record))) {
    return "error";
  }
  if (WARNING_RECORD_START.test(record) && !CAPABILITY_NOTICE.test(record)) {
    return "warning";
  }
  return null;
}

function progress(lines: string[], errors: string[]) {
  if (lines.some((line) => READY.test(line))) {
    return loadProgress("ready", 100, "vLLM API server is ready.", false);
  }
  const error = errors[errors.length - 1];
  if (error !== undefined) {
    return loadProgress("error", null, error, false);
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

function listeningUrl(line: string) {
  return /(https?:\/\/[^\s]+)/i.exec(line)?.[1] ?? null;
}

function latestValues(lines: string[]) {
  const found: {
    listeningUrl: string | null;
    modelPath: string | null;
    modelAlias: string | null;
    contextSize: number | null;
  } = {
    listeningUrl: null,
    modelPath: null,
    modelAlias: null,
    contextSize: null,
  };
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    found.listeningUrl ??= listeningUrl(line);
    found.modelPath ??= modelPath(line);
    found.modelAlias ??= modelAlias(line);
    found.contextSize ??= contextSize(line);
    if (
      found.listeningUrl !== null &&
      found.modelPath !== null &&
      found.modelAlias !== null &&
      found.contextSize !== null
    ) {
      break;
    }
  }
  return found;
}

export const vllmLogParser: EngineLogParser = {
  parse: ({ lines }) => {
    const { errors, warnings } = classifiedTails(lines, classify, 8);
    return {
      ...latestValues(lines),
      gpuLayers: null,
      slots: null,
      ready: lines.some((line) => READY.test(line)),
      warnings,
      errors,
      notices: tailMatches(
        lines,
        /Application startup complete|Started server process|loading model weights|EngineCore|torch\.compile|Available KV cache memory|GPU KV cache size|CUDA graphs?|Model Runner V2 does not yet support the thinking_token_budget/i,
        10,
      ),
      loadProgress: progress(lines, errors),
      memoryLayout: emptyMemoryLayout(),
    };
  },
};
