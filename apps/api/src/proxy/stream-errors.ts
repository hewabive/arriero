import {
  apiProxyResponseShape,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
  type ApiProxyResponseShape,
} from "./protocol.js";
import {
  apiProxySseDataFrame,
  apiProxySseEventFrame,
  createApiProxySseFrameBuffer,
  parseApiProxySseJsonFrame,
} from "./response-codec.js";
import { asObject } from "./json.js";

const errorFrames: Record<
  ApiProxyResponseShape,
  (
    body: unknown,
    diagnostic: ApiProxyProtocolDiagnostic,
    sequence: number,
  ) => string
> = {
  "openai-chat": (body) => `${apiProxySseDataFrame(body)}data: [DONE]\n\n`,
  anthropic: (body) => apiProxySseEventFrame("error", body),
  "openai-responses": (_body, diagnostic, sequence) =>
    apiProxySseEventFrame("error", {
      type: "error",
      code: diagnostic.code,
      message: diagnostic.message,
      param: diagnostic.param ?? null,
      sequence_number: sequence,
    }),
};

export function recoverApiProxySseStream(input: {
  body: ReadableStream<Uint8Array>;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  onError: (error: unknown) => ApiProxyProtocolDiagnostic | null;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  const frames = createApiProxySseFrameBuffer();
  const encoder = new TextEncoder();
  const shape = apiProxyResponseShape(input.request.operation);
  let nextSequence = 0;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (cancelled) return;
          if (chunk.done) {
            const tail = frames.flush();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            reader.releaseLock();
            return;
          }
          const complete = frames.push(chunk.value);
          for (const frame of complete) {
            if (shape === "openai-responses") {
              for (const { value } of parseApiProxySseJsonFrame(frame)
                .payloads) {
                const sequence = asObject(value)?.sequence_number;
                if (
                  typeof sequence === "number" &&
                  Number.isSafeInteger(sequence)
                ) {
                  nextSequence = Math.max(nextSequence, sequence + 1);
                }
              }
            }
            controller.enqueue(encoder.encode(frame));
          }
          if (complete.length > 0) return;
        }
      } catch (error) {
        if (cancelled) return;
        reader.releaseLock();
        const diagnostic = input.onError(error);
        if (!diagnostic) {
          controller.error(error);
          return;
        }
        const response = input.adapter.diagnosticError(
          input.request,
          diagnostic,
        );
        controller.enqueue(
          encoder.encode(
            errorFrames[shape](response.body, diagnostic, nextSequence),
          ),
        );
        controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
