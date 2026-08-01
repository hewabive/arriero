import { saveApiProxyRequestFile } from "./request-files.js";
import type {
  ApiProxyCacheStoreEffect,
  ApiProxyCaptureResponseEffect,
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

export type ApiProxyResponseCaptureSink = {
  tap: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  setBody: (data: unknown) => void;
  setText: (text: string) => void;
  flush: () => void;
};

function looksLikeErrorBody(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Boolean((data as { error?: unknown }).error)
  );
}

export function createApiProxyResponseCaptureSink(input: {
  captures: ApiProxyCaptureResponseEffect[];
  cacheWrites: ApiProxyCacheStoreEffect[];
  putCache: ApiProxyResponseCacheWriter;
  trace: ProxyTraceAccumulator;
  operation: ApiProxyProtocolOperation;
}): ApiProxyResponseCaptureSink | null {
  if (input.captures.length === 0 && input.cacheWrites.length === 0) {
    return null;
  }

  let explicit: { data: unknown } | null = null;
  let explicitText: string | null = null;
  let streamedText = "";
  let tapped = false;
  let flushed = false;

  const flush = () => {
    if (flushed) {
      return;
    }
    flushed = true;
    let data: unknown;
    if (explicit) {
      data = explicit.data;
    } else if (tapped) {
      data = streamedText;
    } else {
      return;
    }
    for (const capture of input.captures) {
      input.trace.files.push(
        saveApiProxyRequestFile({
          traceId: input.trace.id,
          traceAt: input.trace.at,
          kind: "capture-response",
          label: capture.nodeName,
          protocol: input.operation.protocol,
          endpoint: input.operation.endpoint,
          routePath: input.operation.routePath,
          modelId: input.trace.modelId,
          data,
        }),
      );
    }
    if (input.cacheWrites.length === 0) {
      return;
    }

    if (tapped) {
      const sse =
        streamedText.length > 0 && !input.trace.errorMessage
          ? streamedText
          : null;
      for (const write of input.cacheWrites) {
        if (sse !== null) {
          input.putCache({
            key: write.key,
            modelId: input.trace.modelId,
            status: 200,
            contentType: "text/event-stream",
            isSse: true,
            body: sse,
            ttlSeconds: write.ttlSeconds,
          });
        }
        finishApiProxyBroadcast(write.key);
      }
      if (sse !== null) {
        input.trace.cache = "store";
      }
      return;
    }

    const body =
      explicitText !== null && !looksLikeErrorBody(data) ? explicitText : null;
    for (const write of input.cacheWrites) {
      if (body !== null) {
        input.putCache({
          key: write.key,
          modelId: input.trace.modelId,
          status: 200,
          contentType: "application/json",
          isSse: false,
          body,
          ttlSeconds: write.ttlSeconds,
        });
        settleApiProxyInFlight(write.key, {
          status: 200,
          contentType: "application/json",
          isSse: false,
          body,
        });
      } else {
        settleApiProxyInFlight(write.key, null);
      }
      finishApiProxyBroadcast(write.key);
    }
    if (body !== null) {
      input.trace.cache = "store";
    }
  };

  return {
    tap(stream) {
      tapped = true;
      const decoder = new TextDecoder();
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          streamedText += decoder.decode(chunk, { stream: true });
          for (const write of input.cacheWrites) {
            pushApiProxyBroadcast(write.key, chunk);
          }
          controller.enqueue(chunk);
        },
        flush() {
          streamedText += decoder.decode();
        },
      });
      return stream.pipeThrough(transform);
    },
    setBody(data) {
      explicit = { data };
    },
    setText(text) {
      explicit = { data: safeJsonParse(text) ?? text };
      explicitText = text;
    },
    flush,
  };
}
