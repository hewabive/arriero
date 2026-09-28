import { logger } from "../logger.js";
import { createApiProxySseFrameBuffer } from "./response-codec.js";
import { createApiProxySseTerminalTracker } from "./sse-terminal.js";

type ControlledStreamProtocol = "openai" | "anthropic";

export function createApiProxyFinishableSseStream(input: {
  body: ReadableStream<Uint8Array>;
  protocol: ControlledStreamProtocol;
  finishSignal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  const frames = createApiProxySseFrameBuffer();
  const tracker = createApiProxySseTerminalTracker(
    input.protocol === "anthropic" ? "anthropic" : "openai-chat",
  );
  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  let closed = false;
  let finished = false;
  let upstreamCancelled = false;

  const cancelUpstream = () => {
    if (upstreamCancelled) {
      return;
    }
    upstreamCancelled = true;
    reader.cancel("in-flight request finished").catch((error: unknown) => {
      logger.debug(
        { error },
        "finishable proxy stream could not cancel its upstream",
      );
    });
  };
  input.finishSignal.addEventListener("abort", cancelUpstream, { once: true });

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) {
      return;
    }
    closed = true;
    input.finishSignal.removeEventListener("abort", cancelUpstream);
    controller.close();
  };

  const enqueueFrames = (list: string[]) => {
    if (list.length === 0) {
      return;
    }
    for (const frame of list) {
      tracker.observeFrame(frame);
    }
    pending.push(encoder.encode(list.join("")));
  };

  const closingFrames = (): string[] => {
    if (finished || tracker.terminal()) {
      return [];
    }
    finished = true;
    return tracker.closingFrames({
      reason: "stop",
      syntheticIdSuffix: "finished",
      closeThinkingSignature: true,
      ensureMessageStart: true,
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const queued = pending.shift();
        if (queued) {
          controller.enqueue(queued);
          return;
        }
        if (input.finishSignal.aborted) {
          cancelUpstream();
          frames.flush();
          const closing = closingFrames();
          if (closing.length > 0) {
            controller.enqueue(encoder.encode(closing.join("")));
            return;
          }
          close(controller);
          return;
        }
        const result = await reader.read();
        if (result.done) {
          if (input.finishSignal.aborted) {
            continue;
          }
          const tail = frames.flush();
          if (tail !== null) {
            enqueueFrames([tail]);
            continue;
          }
          close(controller);
          return;
        }
        enqueueFrames(frames.push(result.value));
      }
    },
    async cancel(reason) {
      closed = true;
      input.finishSignal.removeEventListener("abort", cancelUpstream);
      await reader.cancel(reason);
    },
  });
}
