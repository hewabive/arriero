import { isRecord } from "./json.js";
import {
  apiProxySseDataFrame,
  apiProxySseEventFrame,
  createApiProxySseFrameBuffer,
  parseApiProxySseJsonFrame,
} from "./response-codec.js";

type ControlledStreamProtocol = "openai" | "anthropic";

type OpenAiEnvelope = {
  id: unknown;
  object: unknown;
  created: unknown;
  model: unknown;
};

type AnthropicBlock = {
  index: number;
  type: string | null;
};

function createTerminalTracker(protocol: ControlledStreamProtocol) {
  let terminal = false;
  let openAiEnvelope: OpenAiEnvelope | null = null;
  let anthropicStarted = false;
  let anthropicModel = "unknown";
  let anthropicId = "msg_arriero-finished";
  let anthropicOutputTokens = 0;
  const anthropicBlocks = new Map<number, AnthropicBlock>();

  const observe = (frame: string) => {
    const parsed = parseApiProxySseJsonFrame(frame);
    terminal ||= parsed.hasDone;
    for (const payload of parsed.payloads) {
      const value = payload.value;
      if (!isRecord(value)) {
        continue;
      }
      if (protocol === "openai") {
        if (Array.isArray(value.choices) && typeof value.id === "string") {
          openAiEnvelope = {
            id: value.id,
            object: value.object,
            created: value.created,
            model: value.model,
          };
        }
        continue;
      }
      if (value.type === "message_start" && isRecord(value.message)) {
        anthropicStarted = true;
        if (typeof value.message.id === "string") {
          anthropicId = value.message.id;
        }
        if (typeof value.message.model === "string") {
          anthropicModel = value.message.model;
        }
      }
      if (
        value.type === "content_block_start" &&
        typeof value.index === "number"
      ) {
        const block = isRecord(value.content_block)
          ? value.content_block
          : null;
        anthropicBlocks.set(value.index, {
          index: value.index,
          type: typeof block?.type === "string" ? block.type : null,
        });
      }
      if (
        value.type === "content_block_stop" &&
        typeof value.index === "number"
      ) {
        anthropicBlocks.delete(value.index);
      }
      if (value.type === "message_delta" && isRecord(value.usage)) {
        if (typeof value.usage.output_tokens === "number") {
          anthropicOutputTokens = value.usage.output_tokens;
        }
      }
      terminal ||= value.type === "message_stop";
    }
  };

  const finish = (): string[] => {
    if (terminal) {
      return [];
    }
    terminal = true;
    if (protocol === "openai") {
      const envelope = openAiEnvelope ?? {
        id: "chatcmpl-arriero-finished",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
      };
      return [
        apiProxySseDataFrame({
          ...envelope,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
        "data: [DONE]\n\n",
      ];
    }
    const output: string[] = [];
    if (!anthropicStarted) {
      output.push(
        apiProxySseEventFrame("message_start", {
          type: "message_start",
          message: {
            id: anthropicId,
            type: "message",
            role: "assistant",
            model: anthropicModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
    for (const block of [...anthropicBlocks.values()].sort(
      (left, right) => left.index - right.index,
    )) {
      if (block.type === "thinking") {
        output.push(
          apiProxySseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "signature_delta", signature: "" },
          }),
        );
      }
      output.push(
        apiProxySseEventFrame("content_block_stop", {
          type: "content_block_stop",
          index: block.index,
        }),
      );
    }
    output.push(
      apiProxySseEventFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: anthropicOutputTokens },
      }),
      apiProxySseEventFrame("message_stop", { type: "message_stop" }),
    );
    return output;
  };

  return { observe, finish };
}

export function createApiProxyFinishableSseStream(input: {
  body: ReadableStream<Uint8Array>;
  protocol: ControlledStreamProtocol;
  finishSignal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  const frames = createApiProxySseFrameBuffer();
  const tracker = createTerminalTracker(input.protocol);
  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  let closed = false;
  let finishRequested = input.finishSignal.aborted;
  let resolveFinish!: () => void;
  const finishPromise = new Promise<void>((resolve) => {
    resolveFinish = resolve;
  });
  const onFinish = () => {
    finishRequested = true;
    resolveFinish();
  };
  input.finishSignal.addEventListener("abort", onFinish, { once: true });
  if (finishRequested) {
    resolveFinish();
  }

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) {
      return;
    }
    closed = true;
    input.finishSignal.removeEventListener("abort", onFinish);
    controller.close();
  };

  const enqueueFrame = (frame: string) => {
    tracker.observe(frame);
    pending.push(encoder.encode(frame));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const queued = pending.shift();
        if (queued) {
          controller.enqueue(queued);
          return;
        }
        if (finishRequested) {
          void reader.cancel("in-flight request finished").catch(() => {});
          frames.flush();
          for (const frame of tracker.finish()) {
            pending.push(encoder.encode(frame));
          }
          const terminal = pending.shift();
          if (terminal) {
            controller.enqueue(terminal);
            return;
          }
          close(controller);
          return;
        }
        const result = await Promise.race([
          reader.read().then((value) => ({ type: "read" as const, value })),
          finishPromise.then(() => ({ type: "finish" as const })),
        ]);
        if (result.type === "finish") {
          continue;
        }
        if (result.value.done) {
          const tail = frames.flush();
          if (tail !== null) {
            enqueueFrame(tail);
            continue;
          }
          close(controller);
          return;
        }
        for (const frame of frames.push(result.value.value)) {
          enqueueFrame(frame);
        }
      }
    },
    async cancel(reason) {
      closed = true;
      input.finishSignal.removeEventListener("abort", onFinish);
      await reader.cancel(reason);
    },
  });
}
