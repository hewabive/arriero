import {
  emptyMemoryLayout,
  loadProgress,
  type EngineLogParser,
} from "./types.js";

const READY = /Uvicorn running on|Application startup complete/i;
const ERROR = /\b(error|fatal|failed|exception|traceback|out of memory|oom)\b/i;
const WARNING = /\b(warn|warning)\b/i;

function tailMatches(lines: string[], pattern: RegExp, limit: number) {
  return lines
    .filter((line) => pattern.test(line))
    .map((line) => line.trim())
    .slice(-limit);
}

function progress(lines: string[]) {
  if (lines.some((line) => READY.test(line))) {
    return loadProgress(
      "ready",
      100,
      "SGLang-KT reports that the API process started; waiting for HTTP health confirmation.",
      false,
    );
  }
  const error = [...lines].reverse().find((line) => ERROR.test(line));
  if (error) return loadProgress("error", null, error.trim(), false);

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
  parse: ({ lines }) => ({
    listeningUrl: lastMatch(lines, /(https?:\/\/[^\s]+)/i),
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
    warnings: tailMatches(lines, WARNING, 8),
    errors: tailMatches(lines, ERROR, 8),
    notices: tailMatches(
      lines,
      /Uvicorn running|Application startup complete|KTransformers|kt[-_ ]kernel|checkpoint shards?|cuda graph|warmup|scheduler/i,
      12,
    ),
    loadProgress: progress(lines),
    memoryLayout: emptyMemoryLayout(),
  }),
};
