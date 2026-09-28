import { isRecord, type JsonRecord } from "./json.js";
import type { ApiProxyResponseShape } from "./protocol.js";
import {
  apiProxySseDataFrame,
  apiProxySseEventFrame,
  isApiProxyTerminalPayload,
  parseApiProxySseJsonFrame,
} from "./response-codec.js";

export type ApiProxyClosableShape = Exclude<
  ApiProxyResponseShape,
  "openai-responses"
>;

type ChatEnvelope = {
  id: unknown;
  object: unknown;
  created: unknown;
  model: unknown;
};

type ClosingReason = "stop" | "length";

const anthropicStopReasons: Record<ClosingReason, string> = {
  stop: "end_turn",
  length: "max_tokens",
};

const anthropicStateMarkers = [
  "[DONE]",
  '"message_start"',
  '"content_block_start"',
  '"content_block_stop"',
  '"message_delta"',
  '"message_stop"',
];

type ApiProxySseClosingOptions = {
  reason: ClosingReason;
  syntheticIdSuffix: string;
  outputTokens?: number | undefined;
  marker?: string | undefined;
  closeThinkingSignature?: boolean | undefined;
  ensureMessageStart?: boolean | undefined;
};

export type ApiProxySseTerminalTracker = {
  observe: (value: unknown) => void;
  observeFrame: (frame: string) => void;
  terminal: () => boolean;
  closingFrames: (options: ApiProxySseClosingOptions) => string[];
};

export function apiProxyClosableShape(
  shape: ApiProxyResponseShape,
): ApiProxyClosableShape | null {
  return shape === "openai-chat" || shape === "anthropic" ? shape : null;
}

export function createApiProxySseTerminalTracker(
  shape: ApiProxyClosableShape,
): ApiProxySseTerminalTracker {
  let terminal = false;
  let chatEnvelope: ChatEnvelope | null = null;
  let messageStarted = false;
  let outputTokens = 0;
  let maxBlockIndex = -1;
  const openBlocks = new Map<number, string | null>();

  const observeAnthropic = (value: JsonRecord) => {
    if (value.type === "message_start" && isRecord(value.message)) {
      messageStarted = true;
    }
    if (
      value.type === "content_block_start" &&
      typeof value.index === "number"
    ) {
      const block = isRecord(value.content_block) ? value.content_block : null;
      openBlocks.set(
        value.index,
        typeof block?.type === "string" ? block.type : null,
      );
      maxBlockIndex = Math.max(maxBlockIndex, value.index);
    }
    if (
      value.type === "content_block_stop" &&
      typeof value.index === "number"
    ) {
      openBlocks.delete(value.index);
    }
    if (
      value.type === "message_delta" &&
      isRecord(value.usage) &&
      typeof value.usage.output_tokens === "number"
    ) {
      outputTokens = value.usage.output_tokens;
    }
  };

  const observe = (value: unknown) => {
    terminal ||= isApiProxyTerminalPayload(value, shape);
    if (!isRecord(value)) {
      return;
    }
    if (shape === "anthropic") {
      observeAnthropic(value);
      return;
    }
    if (Array.isArray(value.choices) && typeof value.id === "string") {
      chatEnvelope = {
        id: value.id,
        object: value.object,
        created: value.created,
        model: value.model,
      };
    }
  };

  const observeFrame = (frame: string) => {
    if (
      shape === "anthropic" &&
      !anthropicStateMarkers.some((marker) => frame.includes(marker))
    ) {
      return;
    }
    const parsed = parseApiProxySseJsonFrame(frame);
    terminal ||= parsed.hasDone;
    for (const payload of parsed.payloads) {
      observe(payload.value);
    }
  };

  const chatClosingFrames = (options: ApiProxySseClosingOptions): string[] => {
    const envelope = chatEnvelope ?? {
      id: `chatcmpl-arriero-${options.syntheticIdSuffix}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "unknown",
    };
    const chunk = (choice: JsonRecord) =>
      apiProxySseDataFrame({ ...envelope, choices: [choice] });
    const output: string[] = [];
    if (options.marker) {
      output.push(
        chunk({
          index: 0,
          delta: { content: options.marker },
          finish_reason: null,
        }),
      );
    }
    output.push(
      chunk({ index: 0, delta: {}, finish_reason: options.reason }),
      "data: [DONE]\n\n",
    );
    return output;
  };

  const anthropicClosingFrames = (
    options: ApiProxySseClosingOptions,
  ): string[] => {
    const output: string[] = [];
    if (options.ensureMessageStart && !messageStarted) {
      output.push(
        apiProxySseEventFrame("message_start", {
          type: "message_start",
          message: {
            id: `msg_arriero-${options.syntheticIdSuffix}`,
            type: "message",
            role: "assistant",
            model: "unknown",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
    for (const [index, type] of [...openBlocks].sort(
      ([left], [right]) => left - right,
    )) {
      if (options.closeThinkingSignature && type === "thinking") {
        output.push(
          apiProxySseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: "" },
          }),
        );
      }
      output.push(
        apiProxySseEventFrame("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
    }
    if (options.marker) {
      const index = maxBlockIndex + 1;
      output.push(
        apiProxySseEventFrame("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
        apiProxySseEventFrame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: options.marker },
        }),
        apiProxySseEventFrame("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
    }
    output.push(
      apiProxySseEventFrame("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: anthropicStopReasons[options.reason],
          stop_sequence: null,
        },
        usage: { output_tokens: options.outputTokens ?? outputTokens },
      }),
      apiProxySseEventFrame("message_stop", { type: "message_stop" }),
    );
    return output;
  };

  return {
    observe,
    observeFrame,
    terminal: () => terminal,
    closingFrames: (options) =>
      shape === "anthropic"
        ? anthropicClosingFrames(options)
        : chatClosingFrames(options),
  };
}
