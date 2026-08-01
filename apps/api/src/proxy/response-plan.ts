import { saveApiProxyRequestFile } from "./request-files.js";
import type {
  ApiProxyCacheStoreEffect,
  ApiProxyResponseEffect,
} from "./pipeline.js";
import type { ApiProxyProtocolOperation } from "./protocol.js";
import { safeJsonParse, type ProxyTraceAccumulator } from "./protocol-trace.js";
import {
  abortApiProxyBroadcast,
  finishApiProxyBroadcast,
  pushApiProxyBroadcast,
} from "./response-broadcast.js";
import { settleApiProxyInFlight } from "./response-coalesce.js";
import {
  createApiProxyResponseReplaceStream,
  replaceApiProxyResponseSseText,
  replaceApiProxyResponseText,
} from "./response-replace.js";
import {
  createApiProxyTokenScaleStream,
  scaleApiProxyResponseTokenText,
} from "./token-scale.js";

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

function settleCacheWithoutBody(
  effect: ApiProxyCacheStoreEffect,
  reason: string,
): void {
  settleApiProxyInFlight(effect.key, null);
  abortApiProxyBroadcast(effect.key, reason);
}

function isSuccessStatus(metadata: ApiProxyResponseMetadata): boolean {
  return metadata.status >= 200 && metadata.status < 300;
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
    tapped: false,
    streamComplete: false,
    flushed: false,
  }));
  let metadata: ApiProxyResponseMetadata | null = null;

  const flushState = (state: EffectState) => {
    if (state.flushed) {
      return;
    }
    state.flushed = true;

    const meta = metadata;
    const text = state.tapped ? state.streamedText : state.explicitText;
    const complete = !state.tapped || state.streamComplete;
    if (state.effect.type === "capture-response") {
      if (
        text === null ||
        !complete ||
        meta === null ||
        !isSuccessStatus(meta) ||
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
          data: meta.isSse ? text : (safeJsonParse(text) ?? text),
        }),
      );
      return;
    }
    if (
      state.effect.type === "replace-response-text" ||
      state.effect.type === "token-scale"
    ) {
      return;
    }

    const parsed = text === null || meta?.isSse ? null : safeJsonParse(text);
    const cacheable =
      text !== null &&
      text.length > 0 &&
      complete &&
      meta !== null &&
      isSuccessStatus(meta) &&
      !input.trace.errorMessage &&
      (meta.isSse || !looksLikeErrorBody(parsed));
    if (!cacheable) {
      settleCacheWithoutBody(
        state.effect,
        input.trace.errorMessage ??
          `Coalesced upstream request for ${input.trace.modelId || "model"} ended without a cacheable response.`,
      );
      return;
    }
    input.putCache({
      key: state.effect.key,
      modelId: input.trace.modelId,
      status: meta.status,
      contentType: meta.contentType,
      isSse: meta.isSse,
      body: text,
      ttlSeconds: state.effect.ttlSeconds,
    });
    if (!meta.isSse) {
      settleApiProxyInFlight(state.effect.key, {
        status: meta.status,
        contentType: meta.contentType,
        isSse: false,
        body: text,
      });
    }
    finishApiProxyBroadcast(state.effect.key);
    input.trace.cache ??= "store";
  };

  const observeText = (state: EffectState, text: string) => {
    state.explicitText = text;
    if (
      state.effect.type === "cache-store" &&
      metadata?.isSse &&
      isSuccessStatus(metadata) &&
      !input.trace.errorMessage
    ) {
      pushApiProxyBroadcast(state.effect.key, new TextEncoder().encode(text));
    }
  };

  const observeStreamGroup = (
    stream: ReadableStream<Uint8Array>,
    group: EffectState[],
  ): ReadableStream<Uint8Array> => {
    for (const state of group) {
      state.tapped = true;
    }
    const meta = metadata;
    const cacheKeys =
      meta && isSuccessStatus(meta)
        ? group.flatMap((state) =>
            state.effect.type === "cache-store" ? [state.effect.key] : [],
          )
        : [];
    const decoder = new TextDecoder();
    let text = "";
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          text += decoder.decode(chunk, { stream: true });
          for (const key of cacheKeys) {
            pushApiProxyBroadcast(key, chunk);
          }
          controller.enqueue(chunk);
        },
        flush() {
          text += decoder.decode();
          for (const state of group) {
            state.streamedText = text;
            state.streamComplete = true;
            flushState(state);
          }
        },
      }),
    );
  };

  return {
    processText(text, meta) {
      metadata = meta;
      const applyTransforms = isSuccessStatus(meta);
      let current = text;
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (!state) {
          continue;
        }
        if (state.effect.type === "replace-response-text") {
          if (!applyTransforms) {
            continue;
          }
          const replacement = meta.isSse
            ? replaceApiProxyResponseSseText({
                text: current,
                operation: input.operation,
                effect: state.effect,
              })
            : replaceApiProxyResponseText({
                text: current,
                operation: input.operation,
                effect: state.effect,
              });
          current = replacement.text;
          input.trace.textReplacementCount += replacement.count;
        } else if (state.effect.type === "token-scale") {
          if (!applyTransforms) {
            continue;
          }
          current = scaleApiProxyResponseTokenText({
            text: current,
            factor: state.effect.factor,
            operation: input.operation,
            isSse: meta.isSse,
          }).text;
        } else {
          observeText(state, current);
        }
      }
      return current;
    },
    tap(stream, meta) {
      metadata = meta;
      const applyTransforms = isSuccessStatus(meta);
      let current = stream;
      let group: EffectState[] = [];
      const drainGroup = () => {
        if (group.length > 0) {
          current = observeStreamGroup(current, group);
          group = [];
        }
      };
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (!state) {
          continue;
        }
        if (state.effect.type === "replace-response-text") {
          if (!applyTransforms) {
            continue;
          }
          drainGroup();
          current = current.pipeThrough(
            createApiProxyResponseReplaceStream({
              operation: input.operation,
              effect: state.effect,
              onReplacement: (count) => {
                input.trace.textReplacementCount += count;
              },
            }),
          );
        } else if (state.effect.type === "token-scale") {
          if (!applyTransforms) {
            continue;
          }
          drainGroup();
          current = current.pipeThrough(
            createApiProxyTokenScaleStream({
              operation: input.operation,
              factor: state.effect.factor,
            }),
          );
        } else {
          group.push(state);
        }
      }
      drainGroup();
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

export function applyApiProxyResponsePlanText(
  plan: ApiProxyResponsePlanExecutor | null,
  text: string,
  metadata: ApiProxyResponseMetadata,
): string {
  return plan ? plan.processText(text, metadata) : text;
}

export function tapApiProxyResponsePlanStream(
  plan: ApiProxyResponsePlanExecutor | null,
  stream: ReadableStream<Uint8Array>,
  status: number,
  headers: Headers,
): ReadableStream<Uint8Array> {
  return plan
    ? plan.tap(stream, {
        status,
        contentType: headers.get("content-type") ?? "text/event-stream",
        isSse: true,
      })
    : stream;
}
