import {
  createSseFrameBuffer,
  type ApiLabProbeProfile,
  type EngineTranslationDialectId,
} from "@arriero/core";
import {
  createAnthropicSseEmitter,
  serializeAnthropicSseEvents,
  translateAnthropicRequest,
  translateOpenAiError,
  translateOpenAiResponse,
  type AnthropicToOpenAiRequestOptions,
} from "@arriero/anthropic-openai-bridge";

import { openAiResumableCodec } from "./openai.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolId,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
} from "./protocol.js";
import { sseDataPayloads } from "./sse.js";
import type { ProxyStreamHealth } from "./stream-health.js";
import { createProxyStreamInspector } from "./stream-inspector.js";
import type { ProxyStreamObserver } from "./stream-observer.js";
import type { ProxyUsageCounts } from "./usage-meter.js";
import {
  contextOverflowMessage,
  isLlamaContextOverflow,
} from "./context-overflow.js";

const translationDialectRequestOptions: Record<
  EngineTranslationDialectId,
  AnthropicToOpenAiRequestOptions
> = {
  "llama-server": {
    namedToolChoice: "filter",
    enableThinkingKwargField: "enable_thinking",
  },
  "openai-compatible": {
    namedToolChoice: "native",
    enableThinkingKwargField: "enable_thinking",
  },
};

const translatedUpstreamPath = "/v1/chat/completions";

export function shouldTranslateAnthropicMessages(
  operation: ApiProxyProtocolOperation,
  upstreamProfile: ApiLabProbeProfile,
): boolean {
  return (
    (apiProxyOperationSpec(operation)?.translatesToOpenAiChat ?? false) &&
    upstreamProfile !== "anthropic"
  );
}

export function translateAnthropicForwardBody(
  body: unknown,
  dialect: EngineTranslationDialectId,
): {
  body: unknown;
  warnings: string[];
} {
  return translateAnthropicRequest(
    body,
    translationDialectRequestOptions[dialect],
  );
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
  translationDialect: EngineTranslationDialectId;
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
  const translated = translateAnthropicForwardBody(
    input.body,
    input.translationDialect,
  );
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

export type AnthropicTranslationStreamCallbacks = ProxyStreamObserver & {
  onComplete?: ((usage: ProxyUsageCounts) => void) | undefined;
  onStreamEnd?: ((health: ProxyStreamHealth) => void) | undefined;
};

export type AnthropicTranslationStream = {
  transform: TransformStream<Uint8Array, Uint8Array>;
  finalize: () => void;
};

export function createAnthropicTranslationStream(
  callbacks: AnthropicTranslationStreamCallbacks = {},
): AnthropicTranslationStream {
  const emitter = createAnthropicSseEmitter();
  const inspector = createProxyStreamInspector({
    codec: openAiResumableCodec,
    observer: callbacks,
  });
  const encoder = new TextEncoder();
  const frames = createSseFrameBuffer();
  let done = false;
  let finalHealth: ProxyStreamHealth | null = null;

  const handleFrame = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const data of sseDataPayloads(frame)) {
      inspector.observeData(data);
      const result = emitter.push(data);
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
    const snapshot = inspector.finish();
    finalHealth = snapshot.health;
    callbacks.onStreamEnd?.(snapshot.health);
    callbacks.onComplete?.({
      promptTokens: snapshot.promptTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheCreationTokens: snapshot.cacheCreationTokens,
      completionTokens: snapshot.completionTokens,
      genMs: snapshot.genMs,
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
      finalize();
      const events = finalHealth?.terminal === "eof" ? [] : emitter.finish();
      if (events.length > 0) {
        controller.enqueue(encoder.encode(serializeAnthropicSseEvents(events)));
      }
    },
  });

  return { transform, finalize };
}
