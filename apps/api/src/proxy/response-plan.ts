import { saveApiProxyRequestFile } from "./request-files.js";
import type {
  ApiProxyCacheStoreEffect,
  ApiProxyResponseEffect,
} from "./pipeline.js";
import type { ApiProxyProtocolOperation } from "./protocol.js";
import { safeJsonParse, type ProxyTraceAccumulator } from "./protocol-trace.js";
import {
  finishApiProxyBroadcast,
  pushApiProxyBroadcast,
} from "./response-broadcast.js";
import { settleApiProxyInFlight } from "./response-coalesce.js";

export type ApiProxyResponseCacheWriter = (input: {
  key: string;
  modelId: string;
  status: number;
  contentType: string;
  isSse: boolean;
  body: string;
  ttlSeconds: number;
}) => void;

export type ApiProxyResponseMetadata = {
  status: number;
  contentType: string;
  isSse: boolean;
};

export type ApiProxyResponsePlanExecutor = {
  processText: (text: string, metadata: ApiProxyResponseMetadata) => string;
  tap: (
    stream: ReadableStream<Uint8Array>,
    metadata: ApiProxyResponseMetadata,
  ) => ReadableStream<Uint8Array>;
  flush: () => void;
};

type EffectState = {
  effect: ApiProxyResponseEffect;
  explicitText: string | null;
  streamedText: string;
  metadata: ApiProxyResponseMetadata | null;
  tapped: boolean;
  streamComplete: boolean;
  flushed: boolean;
};

function looksLikeErrorBody(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Boolean((data as { error?: unknown }).error)
  );
}

function settleCacheWithoutBody(effect: ApiProxyCacheStoreEffect): void {
  settleApiProxyInFlight(effect.key, null);
  finishApiProxyBroadcast(effect.key);
}

export function createApiProxyResponsePlanExecutor(input: {
  effects: ApiProxyResponseEffect[];
  putCache: ApiProxyResponseCacheWriter;
  trace: ProxyTraceAccumulator;
  operation: ApiProxyProtocolOperation;
}): ApiProxyResponsePlanExecutor | null {
  if (input.effects.length === 0) {
    return null;
  }

  const states: EffectState[] = input.effects.map((effect) => ({
    effect,
    explicitText: null,
    streamedText: "",
    metadata: null,
    tapped: false,
    streamComplete: false,
    flushed: false,
  }));

  const flushState = (state: EffectState) => {
    if (state.flushed) {
      return;
    }
    state.flushed = true;

    const text = state.tapped ? state.streamedText : state.explicitText;
    const complete = !state.tapped || state.streamComplete;
    if (state.effect.type === "capture-response") {
      if (
        text === null ||
        !complete ||
        state.metadata === null ||
        state.metadata.status < 200 ||
        state.metadata.status >= 300 ||
        Boolean(input.trace.errorMessage)
      ) {
        return;
      }
      input.trace.files.push(
        saveApiProxyRequestFile({
          traceId: input.trace.id,
          traceAt: input.trace.at,
          kind: "capture-response",
          label: state.effect.nodeName,
          protocol: input.operation.protocol,
          endpoint: input.operation.endpoint,
          routePath: input.operation.routePath,
          modelId: input.trace.modelId,
          data: state.metadata?.isSse ? text : (safeJsonParse(text) ?? text),
        }),
      );
      return;
    }

    const metadata = state.metadata;
    const parsed =
      text === null || metadata?.isSse ? null : safeJsonParse(text);
    const cacheable =
      text !== null &&
      text.length > 0 &&
      complete &&
      metadata !== null &&
      metadata.status >= 200 &&
      metadata.status < 300 &&
      !input.trace.errorMessage &&
      (metadata.isSse || !looksLikeErrorBody(parsed));
    if (!cacheable) {
      settleCacheWithoutBody(state.effect);
      return;
    }
    input.putCache({
      key: state.effect.key,
      modelId: input.trace.modelId,
      status: metadata.status,
      contentType: metadata.contentType,
      isSse: metadata.isSse,
      body: text,
      ttlSeconds: state.effect.ttlSeconds,
    });
    if (!metadata.isSse) {
      settleApiProxyInFlight(state.effect.key, {
        status: metadata.status,
        contentType: metadata.contentType,
        isSse: false,
        body: text,
      });
    }
    finishApiProxyBroadcast(state.effect.key);
    input.trace.cache = "store";
  };

  const observeText = (
    state: EffectState,
    text: string,
    metadata: ApiProxyResponseMetadata,
  ) => {
    state.explicitText = text;
    state.metadata = metadata;
    if (state.effect.type === "cache-store" && metadata.isSse) {
      pushApiProxyBroadcast(state.effect.key, new TextEncoder().encode(text));
    }
  };

  const observeStream = (
    stream: ReadableStream<Uint8Array>,
    state: EffectState,
    metadata: ApiProxyResponseMetadata,
  ) => {
    state.tapped = true;
    state.metadata = metadata;
    const decoder = new TextDecoder();
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.streamedText += decoder.decode(chunk, { stream: true });
          if (state.effect.type === "cache-store") {
            pushApiProxyBroadcast(state.effect.key, chunk);
          }
          controller.enqueue(chunk);
        },
        flush() {
          state.streamedText += decoder.decode();
          state.streamComplete = true;
          flushState(state);
        },
      }),
    );
  };

  return {
    processText(text, metadata) {
      let current = text;
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (state) {
          observeText(state, current, metadata);
        }
      }
      return current;
    },
    tap(stream, metadata) {
      let current = stream;
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (state) {
          current = observeStream(current, state, metadata);
        }
      }
      return current;
    },
    flush() {
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (state) {
          flushState(state);
        }
      }
    },
  };
}
