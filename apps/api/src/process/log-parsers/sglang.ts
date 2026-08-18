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

const READY = /Uvicorn running on|Application startup complete/i;
const RECORD_PREFIX =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?[^\]]*\]\s?/;
const ERROR_MESSAGE_STARTS = [
  PYTHON_TRACEBACK_START,
  PYTHON_EXCEPTION_START,
  /^\w+ hit an exception/,
  /^In import_model_classes:(?!.*\bIgnore import error\b).*import error/i,
];
const WARNING_MESSAGE_STARTS = [/^warning\b/i, /^\S+\.py:\d+:\s*\w*Warning\b/];
const DEPRECATION_WARNING = /^\S+\.py:\d+:\s*\w*DeprecationWarning\b/;
const IGNORED_TRACEBACK_BLOCK_START =
  /\[start of libtorchcodec loading traceback\]/;
const IGNORED_TRACEBACK_BLOCK_END =
  /\[end of libtorchcodec loading traceback\]/;

function messageOf(line: string) {
  return line.replace(RECORD_PREFIX, "");
}

function startsInsideIgnoredBlock(lines: string[]) {
  for (const line of lines) {
    if (IGNORED_TRACEBACK_BLOCK_START.test(line)) return false;
    if (IGNORED_TRACEBACK_BLOCK_END.test(line)) return true;
  }
  return false;
}

function withoutIgnoredTracebackBlocks(lines: string[]) {
  const kept: string[] = [];
  let inIgnoredBlock = startsInsideIgnoredBlock(lines);
  for (const line of lines) {
    if (!inIgnoredBlock && IGNORED_TRACEBACK_BLOCK_START.test(line)) {
      inIgnoredBlock = true;
      continue;
    }
    if (inIgnoredBlock) {
      if (IGNORED_TRACEBACK_BLOCK_END.test(line)) {
        inIgnoredBlock = false;
      }
      continue;
    }
    kept.push(line);
  }
  return kept;
}

function classify(line: string): LogLineLevel | null {
  const message = messageOf(line);
  if (ERROR_MESSAGE_STARTS.some((pattern) => pattern.test(message))) {
    return "error";
  }
  if (DEPRECATION_WARNING.test(message)) {
    return null;
  }
  if (WARNING_MESSAGE_STARTS.some((pattern) => pattern.test(message))) {
    return "warning";
  }
  return null;
}

function progress(lines: string[], errors: string[]) {
  if (lines.some((line) => READY.test(line))) {
    return loadProgress(
      "ready",
      100,
      "SGLang-KT reports that the API process started; waiting for HTTP health confirmation.",
      false,
    );
  }
  const error = errors[errors.length - 1];
  if (error !== undefined) return loadProgress("error", null, error, false);

  const shard = [...lines]
    .reverse()
    .map((line) =>
      /(?:checkpoint shards?|shards?).*?(\d+)\s*\/\s*(\d+)/i.exec(line),
    )
    .find(Boolean);
  if (shard?.[1] && shard[2]) {
    const current = Number(shard[1]);
    const total = Number(shard[2]);
    const percent =
      total > 0
        ? Math.max(10, Math.min(80, Math.round((current / total) * 80)))
        : null;
    return loadProgress(
      "tensors",
      percent,
      `SGLang-KT is loading model weight shard ${current}/${total}.`,
    );
  }
  if (
    lines.some((line) =>
      /kt[-_ ]kernel|ktransformers|kt weight|expert weight|load.*weights/i.test(
        line,
      ),
    )
  ) {
    return loadProgress(
      "tensors",
      null,
      "KTransformers is loading CPU expert weights and kernels.",
    );
  }
  if (lines.some((line) => /cuda graph|warmup|warming up/i.test(line))) {
    return loadProgress("warmup", 90, "SGLang-KT is warming up the runtime.");
  }
  if (
    lines.some((line) => /scheduler|tokenizer|memory pool|kv cache/i.test(line))
  ) {
    return loadProgress(
      "context",
      75,
      "SGLang-KT is initializing scheduler and memory pools.",
    );
  }
  if (lines.some((line) => /load.*model|model path|model_path/i.test(line))) {
    return loadProgress("metadata", 10, "SGLang-KT is loading model metadata.");
  }
  return loadProgress("starting", 5, "Starting the SGLang-KT API server.");
}

function lastMatch(lines: string[], pattern: RegExp) {
  return (
    [...lines]
      .reverse()
      .map((line) => pattern.exec(line)?.[1] ?? null)
      .find(Boolean) ?? null
  );
}

export const sglangLogParser: EngineLogParser = {
  parse: ({ lines }) => {
    const { errors, warnings } = classifiedTails(
      withoutIgnoredTracebackBlocks(lines),
      classify,
      8,
    );
    return {
      listeningUrl: lastMatch(
        lines,
        /Uvicorn running on\s+(https?:\/\/[^\s]+)/i,
      ),
      modelPath: lastMatch(
        lines,
        /(?:model(?:_path)?|model path)\s*[:=]\s*["']?([^\s,"']+)/i,
      ),
      modelAlias: lastMatch(
        lines,
        /served(?:_model_name| model name)\s*[:=]\s*["']?([^\s,"']+)/i,
      ),
      contextSize: (() => {
        const raw = lastMatch(
          lines,
          /(?:context_length|max_total_num_tokens)\s*[:=]\s*(\d+)/i,
        );
        return raw ? Number(raw) : null;
      })(),
      gpuLayers: null,
      slots: null,
      ready: lines.some((line) => READY.test(line)),
      warnings,
      errors,
      notices: tailMatches(
        lines,
        /Uvicorn running|Application startup complete|KTransformers|kt[-_ ]kernel|checkpoint shards?|cuda graph|warmup|scheduler|DSV4 side-effect import failed:|Ignore import error when loading sglang\.srt\.models\.deepseek_v4/i,
        12,
      ),
      loadProgress: progress(lines, errors),
      memoryLayout: emptyMemoryLayout(),
    };
  },
};
