import { logger } from "../logger.js";
import { observeBodyCompletion } from "./body-completion.js";
import { isEventStream } from "./http.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolDiagnostic,
  ApiProxyProtocolModelRequest,
} from "./protocol.js";
import {
  applyTraceDiagnostic,
  type ProxyTraceAccumulator,
} from "./protocol-trace.js";
import {
  tapApiProxyResponsePlanStream,
  type ApiProxyResponsePlanExecutor,
} from "./response-plan.js";
import { recoverApiProxySseStream } from "./stream-errors.js";

async function drainApiProxyStream(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } catch (error) {
    logger.debug(
      { error },
      "proxy stream drained for its cache owner ended with an error",
    );
  } finally {
    reader.releaseLock();
  }
}

function decoupledStreamResponse(
  observed: ReadableStream<Uint8Array>,
  streamOwnerKey: string | null,
  init: ResponseInit,
): Response {
  if (!streamOwnerKey) {
    return new Response(observed, init);
  }
  const [client, drain] = observed.tee();
  void drainApiProxyStream(drain);
  return new Response(client, init);
}

export function deliverApiProxySseResponse(input: {
  body: ReadableStream<Uint8Array>;
  status: number;
  headers: Headers;
  statusText?: string | undefined;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  trace: ProxyTraceAccumulator;
  responsePlan: ApiProxyResponsePlanExecutor | null;
  streamOwnerKey: string | null;
  onSettled: () => void;
  onError: (error: unknown) => ApiProxyProtocolDiagnostic | null;
}): Response {
  const { trace, responsePlan } = input;
  const recovered = isEventStream(input.headers)
    ? recoverApiProxySseStream({
        body: input.body,
        adapter: input.adapter,
        request: input.request,
        onError(error) {
          const diagnostic = input.onError(error);
          if (diagnostic) {
            applyTraceDiagnostic(trace, diagnostic);
            responsePlan?.markTruncated();
          }
          return diagnostic;
        },
      })
    : input.body;
  const observed = observeBodyCompletion(
    tapApiProxyResponsePlanStream(
      responsePlan,
      recovered,
      input.status,
      input.headers,
    ),
    input.onSettled,
  );
  const init: ResponseInit = input.statusText
    ? {
        status: input.status,
        headers: input.headers,
        statusText: input.statusText,
      }
    : { status: input.status, headers: input.headers };
  return decoupledStreamResponse(observed, input.streamOwnerKey, init);
}
