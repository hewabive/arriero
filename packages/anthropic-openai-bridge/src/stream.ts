import { asArray, asObject, asString, numberOrNull } from "./json.js";
import { mapOpenAiFinishReason } from "./finish-reason.js";
import { anthropicMessageId } from "./response.js";
import type {
  AnthropicContentBlock,
  AnthropicContentBlockDelta,
  AnthropicStreamEvent,
} from "./types.js";

export type AnthropicSseEmitterOptions = {
  messageIdPrefix?: string;
};

export type AnthropicPromptProgress = {
  total: number;
  processed: number;
  cache: number;
};

export type AnthropicSseExtensions = {
  promptProgress?: AnthropicPromptProgress;
  timings?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

export type AnthropicSsePushResult = {
  events: AnthropicStreamEvent[];
  extensions: AnthropicSseExtensions;
};

export type AnthropicSseEmitter = {
  push: (data: string) => AnthropicSsePushResult;
  finish: () => AnthropicStreamEvent[];
};

type OpenBlock = { kind: "thinking" } | { kind: "text" };

type BufferedTool = {
  id: string;
  name: string;
  arguments: string;
};

export function createAnthropicSseEmitter(
  options: AnthropicSseEmitterOptions = {},
): AnthropicSseEmitter {
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let block: OpenBlock | null = null;
  const bufferedTools = new Map<number, BufferedTool>();
  let sawToolBlock = false;
  let finishReason: string | null = null;
  let promptTokens: number | null = null;
  let cachedTokens: number | null = null;
  let completionTokens: number | null = null;
  let progressTotal: number | null = null;
  let progressCache: number | null = null;

  const closeBlock = (events: AnthropicStreamEvent[]) => {
    if (!block) {
      return;
    }
    const index = nextIndex - 1;
    if (block.kind === "thinking") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "" },
      });
    }
    events.push({ type: "content_block_stop", index });
    block = null;
  };

  const openBlock = (
    events: AnthropicStreamEvent[],
    contentBlock: AnthropicContentBlock,
  ) => {
    events.push({
      type: "content_block_start",
      index: nextIndex,
      content_block: contentBlock,
    });
    nextIndex += 1;
  };

  const pushDelta = (
    events: AnthropicStreamEvent[],
    delta: AnthropicContentBlockDelta,
  ) => {
    events.push({ type: "content_block_delta", index: nextIndex - 1, delta });
  };

  const flushTools = (events: AnthropicStreamEvent[]) => {
    for (const [toolIndex, tool] of [...bufferedTools].sort(
      ([left], [right]) => left - right,
    )) {
      openBlock(events, {
        type: "tool_use",
        id: tool.id || `toolu_${toolIndex}`,
        name: tool.name,
        input: {},
      });
      if (tool.arguments) {
        pushDelta(events, {
          type: "input_json_delta",
          partial_json: tool.arguments,
        });
      }
      events.push({ type: "content_block_stop", index: nextIndex - 1 });
    }
    bufferedTools.clear();
  };

  const ensureStarted = (
    events: AnthropicStreamEvent[],
    id: unknown,
    model: unknown,
  ) => {
    if (started) {
      return;
    }
    started = true;
    const inputTokens =
      progressTotal !== null
        ? Math.max(0, progressTotal - (progressCache ?? 0))
        : 0;
    events.push({
      type: "message_start",
      message: {
        id: anthropicMessageId(id, options.messageIdPrefix),
        type: "message",
        role: "assistant",
        model: asString(model) ?? "unknown",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          ...(progressCache !== null
            ? { cache_read_input_tokens: progressCache }
            : {}),
        },
      },
    });
  };

  const finalize = (): AnthropicStreamEvent[] => {
    if (!started || finished) {
      finished = true;
      return [];
    }
    finished = true;
    const events: AnthropicStreamEvent[] = [];
    closeBlock(events);
    flushTools(events);
    const inputTokens =
      promptTokens !== null
        ? Math.max(0, promptTokens - (cachedTokens ?? 0))
        : progressTotal !== null
          ? Math.max(0, progressTotal - (progressCache ?? 0))
          : null;
    const cacheRead = cachedTokens ?? progressCache;
    events.push({
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAiFinishReason(finishReason, sawToolBlock),
        stop_sequence: null,
      },
      usage: {
        output_tokens: completionTokens ?? 0,
        ...(inputTokens !== null ? { input_tokens: inputTokens } : {}),
        ...(cacheRead !== null ? { cache_read_input_tokens: cacheRead } : {}),
      },
    });
    events.push({ type: "message_stop" });
    return events;
  };

  const push = (data: string): AnthropicSsePushResult => {
    const extensions: AnthropicSseExtensions = {};
    if (finished) {
      return { events: [], extensions };
    }
    if (data === "[DONE]") {
      return { events: finalize(), extensions };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { events: [], extensions };
    }
    const chunk = asObject(parsed);
    if (!chunk) {
      return { events: [], extensions };
    }

    const events: AnthropicStreamEvent[] = [];

    if (chunk.error !== undefined) {
      const error = asObject(chunk.error);
      events.push({
        type: "error",
        error: {
          type: "api_error",
          message:
            asString(error?.message) ??
            asString(chunk.error) ??
            "Upstream stream error.",
        },
      });
      return { events, extensions };
    }

    const progress = asObject(chunk.prompt_progress);
    if (progress) {
      const total = numberOrNull(progress.total);
      const processed = numberOrNull(progress.processed);
      if (total !== null && processed !== null) {
        const cache = numberOrNull(progress.cache) ?? 0;
        progressTotal = total;
        progressCache = cache;
        extensions.promptProgress = { total, processed, cache };
      }
    }
    const timings = asObject(chunk.timings);
    if (timings) {
      extensions.timings = timings;
    }
    const usage = asObject(chunk.usage);
    if (usage) {
      extensions.usage = usage;
      promptTokens = numberOrNull(usage.prompt_tokens) ?? promptTokens;
      completionTokens =
        numberOrNull(usage.completion_tokens) ?? completionTokens;
      cachedTokens =
        numberOrNull(asObject(usage.prompt_tokens_details)?.cached_tokens) ??
        cachedTokens;
    }

    const wasStarted = started;
    ensureStarted(events, chunk.id, chunk.model);

    const choice = asObject(asArray(chunk.choices)?.[0]);
    const delta = asObject(choice?.delta);

    const reasoning =
      asString(delta?.reasoning_content) ?? asString(delta?.reasoning);
    if (reasoning) {
      if (block?.kind !== "thinking") {
        closeBlock(events);
        openBlock(events, { type: "thinking", thinking: "" });
        block = { kind: "thinking" };
      }
      pushDelta(events, { type: "thinking_delta", thinking: reasoning });
    }

    for (const entry of asArray(delta?.tool_calls) ?? []) {
      const call = asObject(entry);
      if (!call) {
        continue;
      }
      const toolIndex = numberOrNull(call.index) ?? 0;
      const fn = asObject(call.function);
      closeBlock(events);
      const existing = bufferedTools.get(toolIndex) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      bufferedTools.set(toolIndex, {
        id: asString(call.id) ?? existing.id,
        name: asString(fn?.name) ?? existing.name,
        arguments: existing.arguments + (asString(fn?.arguments) ?? ""),
      });
      sawToolBlock = true;
    }

    const text = asString(delta?.content);
    if (text) {
      flushTools(events);
      if (block?.kind !== "text") {
        closeBlock(events);
        openBlock(events, { type: "text", text: "" });
        block = { kind: "text" };
      }
      pushDelta(events, { type: "text_delta", text });
    }

    const reason = asString(choice?.finish_reason);
    if (reason) {
      finishReason = reason;
      closeBlock(events);
    }

    if (wasStarted && events.length === 0 && progress) {
      events.push({ type: "ping" });
    }

    return { events, extensions };
  };

  return { push, finish: finalize };
}
