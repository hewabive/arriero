import { createSseFrameBuffer } from "@arriero/core";

import { asObject, numberOrNull } from "./json.js";
import type { ApiProxyProtocolId, ApiProxyResumableCodec } from "./protocol.js";
import { sseDataPayloads } from "./sse.js";
import {
  classifyProxyStreamTerminal,
  emptyProxyStreamHealth,
  noteMalformedPayload,
  type ProxyStreamHealth,
} from "./stream-health.js";
import {
  createProxyChunkObserver,
  emptyProxyStreamUsageTally,
  type ProxyStreamObserver,
  type ProxyStreamUsageTally,
} from "./stream-observer.js";

export type ProxyUsageCounts = ProxyStreamUsageTally & {
  genMs: number;
  prefillMs: number | null;
  promptPerSecond: number | null;
};

export function anthropicPromptTokens(
  usage: Record<string, unknown> | null | undefined,
): number | null {
  if (!usage) {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const key of [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    const value = numberOrNull(usage[key]);
    if (value !== null) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

export function anthropicCacheReadTokens(
  usage: Record<string, unknown> | null | undefined,
): number | null {
  return numberOrNull(usage?.cache_read_input_tokens);
}

export function anthropicCacheCreationTokens(
  usage: Record<string, unknown> | null | undefined,
): number | null {
  return numberOrNull(usage?.cache_creation_input_tokens);
}

export function openaiCachedTokens(
  usage: Record<string, unknown> | null | undefined,
): number | null {
  const promptDetails = asObject(usage?.prompt_tokens_details);
  const inputDetails = asObject(usage?.input_tokens_details);
  return (
    numberOrNull(promptDetails?.cached_tokens) ??
    numberOrNull(inputDetails?.cached_tokens)
  );
}

export function usageFromNonStreamBody(
  protocol: ApiProxyProtocolId,
  bodyText: string,
): ProxyUsageCounts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const obj = asObject(parsed);
  const usage = asObject(obj?.usage);
  if (!usage) {
    return null;
  }
  const timings = asObject(obj?.timings);
  const predictedMs = timings ? (numberOrNull(timings.predicted_ms) ?? 0) : 0;
  const promptMs = timings ? numberOrNull(timings.prompt_ms) : null;
  const promptPerSecond = timings
    ? numberOrNull(timings.prompt_per_second)
    : null;
  const prefillMs = promptMs === null ? null : Math.round(promptMs);
  if (protocol === "anthropic") {
    const completionTokens = numberOrNull(usage.output_tokens);
    if (completionTokens === null) {
      return null;
    }
    return {
      promptTokens: anthropicPromptTokens(usage),
      cacheReadTokens: anthropicCacheReadTokens(usage),
      cacheCreationTokens: anthropicCacheCreationTokens(usage),
      completionTokens,
      genMs: Math.round(predictedMs),
      prefillMs,
      promptPerSecond,
    };
  }
  const completionTokens =
    numberOrNull(usage.completion_tokens) ?? numberOrNull(usage.output_tokens);
  const promptTokens =
    numberOrNull(usage.prompt_tokens) ?? numberOrNull(usage.input_tokens);
  if (completionTokens === null && promptTokens === null) {
    return null;
  }
  return {
    promptTokens,
    cacheReadTokens: openaiCachedTokens(usage),
    cacheCreationTokens: null,
    completionTokens: completionTokens ?? 0,
    genMs: Math.round(predictedMs),
    prefillMs,
    promptPerSecond,
  };
}

export function includeUsageRequested(body: unknown): boolean {
  const streamOptions = asObject(asObject(body)?.stream_options);
  return streamOptions?.include_usage === true;
}

export function withIncludeUsage(body: unknown): unknown {
  const obj = asObject(body);
  if (!obj) {
    return body;
  }
  const streamOptions = asObject(obj.stream_options) ?? {};
  return {
    ...obj,
    stream_options: { ...streamOptions, include_usage: true },
  };
}

export function requestBreaksStreamReconstruction(body: unknown): boolean {
  const obj = asObject(body);
  if (!obj) {
    return false;
  }
  if (typeof obj.n === "number" && obj.n > 1) {
    return true;
  }
  if (obj.logprobs === true || typeof obj.logprobs === "number") {
    return true;
  }
  if (obj.top_logprobs !== undefined && obj.top_logprobs !== null) {
    return true;
  }
  return false;
}

export function returnProgressRequested(body: unknown): boolean {
  return asObject(body)?.return_progress === true;
}

export function withReturnProgress(body: unknown): unknown {
  const obj = asObject(body);
  if (!obj) {
    return body;
  }
  return { ...obj, return_progress: true };
}

export function ratePerSecondFromUsage(usage: ProxyUsageCounts): number | null {
  return usage.completionTokens > 0 && usage.genMs > 0
    ? usage.completionTokens / (usage.genMs / 1000)
    : null;
}

export type UsageMeterStream = {
  transform: TransformStream<Uint8Array, Uint8Array>;
  finalize: () => void;
  health: () => ProxyStreamHealth;
};

export function createUsageMeterStream(
  input: {
    codec: Pick<ApiProxyResumableCodec, "parseChunk">;
    stripUsageFrames: boolean;
    stripProgressFrames?: boolean;
    onComplete: (usage: ProxyUsageCounts) => void;
    onStreamEnd?: (health: ProxyStreamHealth) => void;
  } & ProxyStreamObserver,
): UsageMeterStream {
  const {
    codec,
    stripUsageFrames,
    stripProgressFrames = false,
    onComplete,
    onStreamEnd,
  } = input;
  const encoder = new TextEncoder();
  const frames = createSseFrameBuffer();
  const usage = emptyProxyStreamUsageTally();
  const observeChunk = createProxyChunkObserver(input, usage);
  let upstreamGenMs: number | null = null;
  let done = false;
  let sawDone = false;
  let sawFinish = false;
  let ended = false;
  const streamHealth = emptyProxyStreamHealth();

  const health = (): ProxyStreamHealth => ({
    ...streamHealth,
    terminal: ended ? classifyProxyStreamTerminal(sawDone, sawFinish) : null,
  });

  const observeFrame = (frame: string): boolean => {
    let keep = true;
    for (const data of sseDataPayloads(frame)) {
      const chunk = codec.parseChunk(data);
      if (chunk === "malformed") {
        noteMalformedPayload(streamHealth, data);
        continue;
      }
      if (chunk === "done") {
        sawDone = true;
        continue;
      }
      if (chunk === null) {
        continue;
      }
      if (chunk.finishReason !== null) {
        sawFinish = true;
      }
      if (typeof chunk.genMs === "number") {
        upstreamGenMs = chunk.genMs;
      }
      const bareCarrier =
        chunk.text === "" && !chunk.toolCall && chunk.finishReason === null;
      if (
        (stripProgressFrames &&
          chunk.promptProgress &&
          bareCarrier &&
          !chunk.usage) ||
        (stripUsageFrames && chunk.usage && bareCarrier)
      ) {
        keep = false;
      }
      observeChunk(chunk);
    }
    return keep;
  };

  const finalize = () => {
    if (done) {
      return;
    }
    done = true;
    onComplete({
      ...usage,
      genMs: upstreamGenMs !== null ? Math.round(upstreamGenMs) : 0,
      prefillMs: null,
      promptPerSecond: null,
    });
  };

  const filterFrames = stripUsageFrames || stripProgressFrames;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!filterFrames) {
        controller.enqueue(chunk);
      }
      for (const frame of frames.push(chunk)) {
        const keep = observeFrame(frame);
        if (filterFrames && keep) {
          controller.enqueue(encoder.encode(`${frame}\n\n`));
        }
      }
    },
    flush(controller) {
      const tail = frames.flush();
      if (tail) {
        const keep = observeFrame(tail);
        if (filterFrames && keep) {
          controller.enqueue(encoder.encode(tail));
        }
      }
      ended = true;
      onStreamEnd?.(health());
      finalize();
    },
  });

  return { transform, finalize, health };
}
