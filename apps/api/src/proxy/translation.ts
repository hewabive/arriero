import type { ApiLabProbeProfile } from "@arriero/core";
import {
  createAnthropicSseEmitter,
  serializeAnthropicSseEvents,
  translateAnthropicRequest,
  translateOpenAiError,
  translateOpenAiResponse,
  type AnthropicSsePushResult,
  type AnthropicStreamEvent,
} from "@arriero/anthropic-openai-bridge";

import { numberOrNull } from "./json.js";
import { openAiResumableCodec } from "./openai.js";
import type {
  ApiProxyProtocolId,
  ApiProxyProtocolOperation,
  ApiProxyResumableCodec,
} from "./protocol.js";
import { createSseFrameBuffer, sseDataPayloads } from "./sse.js";
import {
  openaiCachedTokens,
  type ProxyPrefillProgress,
  type ProxyUsageCounts,
} from "./usage-meter.js";
import {
  contextOverflowMessage,
  isLlamaContextOverflow,
} from "./context-overflow.js";

const llamaServerRequestOptions = {
  namedToolChoice: "filter" as const,
  enableThinkingKwargField: "enable_thinking",
};

const translatedUpstreamPath = "/v1/chat/completions";

export function shouldTranslateAnthropicMessages(
  operation: ApiProxyProtocolOperation,
  upstreamProfile: ApiLabProbeProfile,
): boolean {
  return (
    operation.protocol === "anthropic" &&
    operation.endpoint === "messages" &&
    upstreamProfile !== "anthropic"
  );
}

export function translateAnthropicForwardBody(body: unknown): {
  body: unknown;
  warnings: string[];
} {
  const translated = translateAnthropicRequest(body, llamaServerRequestOptions);
  return { body: translated.body, warnings: translated.warnings };
}

export type UpstreamExchange = {
  protocol: ApiProxyProtocolId;
  path: string;
  body: unknown;
  headers: Headers;
  warnings: string[];
};

export function prepareUpstreamExchange(input: {
  translate: boolean;
  operation: ApiProxyProtocolOperation;
  path: string;
  body: unknown;
  headers: Headers;
}): UpstreamExchange {
  if (!input.translate) {
    return {
      protocol: input.operation.protocol,
      path: input.path,
      body: input.body,
      headers: input.headers,
      warnings: [],
    };
  }
  const translated = translateAnthropicForwardBody(input.body);
  return {
    protocol: "openai",
    path: translatedUpstreamPath,
    body: translated.body,
    headers: anthropicForwardHeaders(input.headers),
    warnings: translated.warnings,
  };
}

export function translatedAnthropicResumableCodec(
  translatedBody: unknown,
): ApiProxyResumableCodec {
  return {
    upstreamBody: (_originalBody, tail) =>
      openAiResumableCodec.upstreamBody(translatedBody, tail),
    parseChunk: openAiResumableCodec.parseChunk,
    finalResponse: (input) => {
      const openAiFinal = openAiResumableCodec.finalResponse(input);
      if (!input.wantsStream) {
        const translated = translateOpenAiResponseText(openAiFinal.body);
        return translated === null
          ? openAiFinal
          : {
              status: openAiFinal.status,
              headers: { "content-type": "application/json" },
              body: translated,
            };
      }
      const emitter = createAnthropicSseEmitter();
      let body = "";
      for (const data of sseDataPayloads(openAiFinal.body)) {
        body += serializeAnthropicSseEvents(emitter.push(data).events);
      }
      body += serializeAnthropicSseEvents(emitter.finish());
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      };
    },
  };
}

export function translateOpenAiResponseText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return JSON.stringify(translateOpenAiResponse(parsed));
}

export function translateOpenAiErrorText(status: number, text: string): string {
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (isLlamaContextOverflow(status, parsed)) {
    return JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: contextOverflowMessage,
      },
    });
  }
  return JSON.stringify(translateOpenAiError(status, parsed));
}

export function anthropicForwardHeaders(headers: Headers): Headers {
  const filtered = new Headers(headers);
  filtered.delete("anthropic-version");
  filtered.delete("anthropic-beta");
  filtered.delete("x-api-key");
  return filtered;
}

export type AnthropicTranslationStreamCallbacks = {
  onFirstToken?: ((promptTokens: number | null) => void) | undefined;
  onReasoning?: (() => void) | undefined;
  onReasoningDelta?: ((text: string) => void) | undefined;
  onAnswerDelta?: ((text: string) => void) | undefined;
  onProgress?: ((completionTokens: number) => void) | undefined;
  onPrefillProgress?: ((progress: ProxyPrefillProgress) => void) | undefined;
  onComplete?: ((usage: ProxyUsageCounts) => void) | undefined;
};

export type AnthropicTranslationStream = {
  transform: TransformStream<Uint8Array, Uint8Array>;
  finalize: () => void;
};

function thinkingStart(event: AnthropicStreamEvent): boolean {
  return (
    event.type === "content_block_start" &&
    event.content_block.type === "thinking"
  );
}

function visibleContentStart(event: AnthropicStreamEvent): boolean {
  return (
    event.type === "content_block_start" &&
    event.content_block.type !== "thinking"
  );
}

export function createAnthropicTranslationStream(
  callbacks: AnthropicTranslationStreamCallbacks = {},
): AnthropicTranslationStream {
  const emitter = createAnthropicSseEmitter();
  const encoder = new TextEncoder();
  const frames = createSseFrameBuffer();
  let promptTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let completionTokens = 0;
  let genMs: number | null = null;
  let firstTokenSeen = false;
  let reasoningSeen = false;
  let done = false;

  const observe = ({ events, extensions }: AnthropicSsePushResult) => {
    if (extensions.promptProgress) {
      callbacks.onPrefillProgress?.(extensions.promptProgress);
    }
    if (extensions.timings) {
      const predicted = numberOrNull(extensions.timings.predicted_ms);
      if (predicted !== null) {
        genMs = predicted;
      }
    }
    if (extensions.usage) {
      const completion = numberOrNull(extensions.usage.completion_tokens);
      if (completion !== null) {
        completionTokens += completion;
      }
      if (promptTokens === null) {
        promptTokens = numberOrNull(extensions.usage.prompt_tokens);
      }
      if (cacheReadTokens === null) {
        cacheReadTokens = openaiCachedTokens(extensions.usage);
      }
    }
    for (const event of events) {
      if (event.type !== "content_block_delta") {
        continue;
      }
      if (event.delta.type === "thinking_delta") {
        callbacks.onReasoningDelta?.(event.delta.thinking);
      } else if (event.delta.type === "text_delta") {
        callbacks.onAnswerDelta?.(event.delta.text);
      }
    }
    if (!reasoningSeen && events.some(thinkingStart)) {
      reasoningSeen = true;
      callbacks.onReasoning?.();
    }
    if (!firstTokenSeen && events.some(visibleContentStart)) {
      firstTokenSeen = true;
      callbacks.onFirstToken?.(promptTokens);
    }
    callbacks.onProgress?.(completionTokens);
  };

  const handleFrame = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const data of sseDataPayloads(frame)) {
      const result = emitter.push(data);
      observe(result);
      if (result.events.length > 0) {
        controller.enqueue(
          encoder.encode(serializeAnthropicSseEvents(result.events)),
        );
      }
    }
  };

  const finalize = () => {
    if (done) {
      return;
    }
    done = true;
    callbacks.onComplete?.({
      promptTokens,
      cacheReadTokens,
      cacheCreationTokens: null,
      completionTokens,
      genMs: genMs !== null ? Math.round(genMs) : 0,
      prefillMs: null,
      promptPerSecond: null,
    });
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of frames.push(chunk)) {
        handleFrame(frame, controller);
      }
    },
    flush(controller) {
      const tail = frames.flush();
      if (tail) {
        handleFrame(tail, controller);
      }
      const events = emitter.finish();
      if (events.length > 0) {
        controller.enqueue(encoder.encode(serializeAnthropicSseEvents(events)));
      }
      finalize();
    },
  });

  return { transform, finalize };
}
