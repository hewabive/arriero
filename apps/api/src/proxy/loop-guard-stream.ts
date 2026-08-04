import type { ApiProxyLoopGuardConfig } from "@arriero/core";
import type {
  ApiProxyLoopGuardDetector,
  ApiProxyLoopGuardHit,
  ApiProxyLoopGuardLane,
} from "./loop-guard.js";
import type { ApiProxyReplaceResponseTextEffect } from "./pipeline.js";
import {
  apiProxyResponseShape,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import {
  createApiProxySseFrameBuffer,
  parseApiProxySseJsonFrame,
} from "./response-codec.js";
import { collectMutableDeltas } from "./response-replace.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractionEffect(
  config: ApiProxyLoopGuardConfig,
): ApiProxyReplaceResponseTextEffect {
  return {
    type: "replace-response-text",
    rules: [],
    includeReasoning: config.reasoning,
    includeToolArguments: config.toolArguments,
  };
}

function detectorLane(lane: string): ApiProxyLoopGuardLane | null {
  if (lane.startsWith("answer:")) {
    return "answer";
  }
  if (lane.startsWith("reasoning:")) {
    return "reasoning";
  }
  if (lane.startsWith("tool:")) {
    return "tool";
  }
  return null;
}

function laneEnabled(
  lane: ApiProxyLoopGuardLane,
  config: ApiProxyLoopGuardConfig,
): boolean {
  if (lane === "answer") {
    return config.answer;
  }
  if (lane === "reasoning") {
    return config.reasoning;
  }
  return config.toolArguments;
}

export function apiProxyLoopGuardFinishSupported(
  operation: ApiProxyProtocolOperation,
): boolean {
  const shape = apiProxyResponseShape(operation);
  return shape === "openai-chat" || shape === "anthropic";
}

type ChatEnvelope = {
  id: unknown;
  object: unknown;
  created: unknown;
  model: unknown;
};

type LoopGuardStreamInput = {
  operation: ApiProxyProtocolOperation;
  config: ApiProxyLoopGuardConfig;
  detector: ApiProxyLoopGuardDetector;
  onFinished?: ((hit: ApiProxyLoopGuardHit) => void) | undefined;
};

export function createApiProxyLoopGuardStream(
  input: LoopGuardStreamInput,
): TransformStream<Uint8Array, Uint8Array> {
  const frames = createApiProxySseFrameBuffer();
  const encoder = new TextEncoder();
  const effect = extractionEffect(input.config);
  const shape = apiProxyResponseShape(input.operation);
  const enforce =
    input.config.action === "finish" &&
    apiProxyLoopGuardFinishSupported(input.operation);
  const openBlocks = new Set<number>();
  let maxBlockIndex = -1;
  let chatEnvelope: ChatEnvelope | null = null;
  let terminated = false;

  const trackShapeState = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }
    if (shape === "openai-chat") {
      if (Array.isArray(value.choices) && typeof value.id === "string") {
        chatEnvelope = {
          id: value.id,
          object: value.object,
          created: value.created,
          model: value.model,
        };
      }
      return;
    }
    if (shape !== "anthropic" || typeof value.type !== "string") {
      return;
    }
    const index = typeof value.index === "number" ? value.index : null;
    if (value.type === "content_block_start" && index !== null) {
      openBlocks.add(index);
      maxBlockIndex = Math.max(maxBlockIndex, index);
    } else if (value.type === "content_block_stop" && index !== null) {
      openBlocks.delete(index);
    }
  };

  const scanFrame = (frame: string): ApiProxyLoopGuardHit | null => {
    const parsed = parseApiProxySseJsonFrame(frame);
    for (const payload of parsed.payloads) {
      trackShapeState(payload.value);
      for (const delta of collectMutableDeltas(
        payload.value,
        input.operation,
        effect,
      )) {
        const lane = detectorLane(delta.lane);
        if (!lane || !laneEnabled(lane, input.config)) {
          continue;
        }
        const hit = input.detector.append(lane, delta.text);
        if (hit) {
          return hit;
        }
      }
    }
    return null;
  };

  const marker =
    input.config.markerText.length > 0 ? `\n\n${input.config.markerText}` : "";

  const finishFrames = (): string[] => {
    if (shape === "anthropic") {
      const event = (type: string, payload: JsonRecord) =>
        `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
      const output: string[] = [];
      for (const index of [...openBlocks].sort((a, b) => a - b)) {
        output.push(
          event("content_block_stop", { type: "content_block_stop", index }),
        );
      }
      if (marker) {
        const index = maxBlockIndex + 1;
        output.push(
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: marker },
          }),
          event("content_block_stop", { type: "content_block_stop", index }),
        );
      }
      const outputTokens = Math.max(
        1,
        Math.round(input.detector.snapshot().scannedChars / 4),
      );
      output.push(
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
        event("message_stop", { type: "message_stop" }),
      );
      return output;
    }
    const envelope = chatEnvelope ?? {
      id: "chatcmpl-arriero-loop-guard",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "unknown",
    };
    const chunk = (extra: JsonRecord) =>
      `data: ${JSON.stringify({ ...envelope, ...extra })}\n\n`;
    const output: string[] = [];
    if (marker) {
      output.push(
        chunk({
          choices: [
            { index: 0, delta: { content: marker }, finish_reason: null },
          ],
        }),
      );
    }
    output.push(
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      "data: [DONE]\n\n",
    );
    return output;
  };

  const handleFrame = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (terminated) {
      return;
    }
    const hit = scanFrame(frame);
    controller.enqueue(encoder.encode(frame));
    if (hit && enforce) {
      for (const tail of finishFrames()) {
        controller.enqueue(encoder.encode(tail));
      }
      terminated = true;
      input.onFinished?.(hit);
      controller.terminate();
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (terminated) {
        return;
      }
      for (const frame of frames.push(chunk)) {
        handleFrame(frame, controller);
        if (terminated) {
          return;
        }
      }
    },
    flush(controller) {
      if (terminated) {
        return;
      }
      const tail = frames.flush();
      if (tail !== null) {
        handleFrame(tail, controller);
      }
    },
  });
}

function feedLane(
  detector: ApiProxyLoopGuardDetector,
  config: ApiProxyLoopGuardConfig,
  lane: ApiProxyLoopGuardLane,
  text: unknown,
): void {
  if (typeof text !== "string" || text.length === 0) {
    return;
  }
  if (!laneEnabled(lane, config)) {
    return;
  }
  detector.append(lane, text);
}

function feedOpenAiChatBody(
  detector: ApiProxyLoopGuardDetector,
  config: ApiProxyLoopGuardConfig,
  body: JsonRecord,
): void {
  if (!Array.isArray(body.choices)) {
    return;
  }
  for (const choice of body.choices) {
    if (!isRecord(choice)) {
      continue;
    }
    feedLane(detector, config, "answer", choice.text);
    const message = isRecord(choice.message) ? choice.message : null;
    if (!message) {
      continue;
    }
    feedLane(detector, config, "answer", message.content);
    for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
      feedLane(detector, config, "reasoning", message[key]);
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (isRecord(toolCall) && isRecord(toolCall.function)) {
          feedLane(detector, config, "tool", toolCall.function.arguments);
        }
      }
    }
  }
}

function feedAnthropicBody(
  detector: ApiProxyLoopGuardDetector,
  config: ApiProxyLoopGuardConfig,
  body: JsonRecord,
): void {
  if (!Array.isArray(body.content)) {
    return;
  }
  for (const block of body.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text") {
      feedLane(detector, config, "answer", block.text);
    } else if (block.type === "thinking") {
      feedLane(detector, config, "reasoning", block.thinking);
    } else if (block.type === "tool_use") {
      try {
        feedLane(detector, config, "tool", JSON.stringify(block.input));
      } catch {
        continue;
      }
    }
  }
}

function feedOpenAiResponsesBody(
  detector: ApiProxyLoopGuardDetector,
  config: ApiProxyLoopGuardConfig,
  body: JsonRecord,
): void {
  if (!Array.isArray(body.output)) {
    return;
  }
  for (const item of body.output) {
    if (!isRecord(item)) {
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part)) {
          feedLane(detector, config, "answer", part.text);
        }
      }
    }
    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (isRecord(part)) {
          feedLane(detector, config, "reasoning", part.text);
        }
      }
    }
    feedLane(detector, config, "tool", item.arguments);
  }
}

export function feedApiProxyLoopGuardText(input: {
  detector: ApiProxyLoopGuardDetector;
  config: ApiProxyLoopGuardConfig;
  operation: ApiProxyProtocolOperation;
  text: string;
  isSse: boolean;
}): void {
  if (input.isSse) {
    const buffer = createApiProxySseFrameBuffer();
    const frames = buffer.push(new TextEncoder().encode(input.text));
    const tail = buffer.flush();
    if (tail !== null) {
      frames.push(tail);
    }
    const effect = extractionEffect(input.config);
    for (const frame of frames) {
      const parsed = parseApiProxySseJsonFrame(frame);
      for (const payload of parsed.payloads) {
        for (const delta of collectMutableDeltas(
          payload.value,
          input.operation,
          effect,
        )) {
          const lane = detectorLane(delta.lane);
          if (lane) {
            feedLane(input.detector, input.config, lane, delta.text);
          }
        }
      }
    }
    input.detector.finalize();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(input.text);
  } catch {
    return;
  }
  if (!isRecord(body)) {
    return;
  }
  switch (apiProxyResponseShape(input.operation)) {
    case "openai-chat":
      feedOpenAiChatBody(input.detector, input.config, body);
      break;
    case "anthropic":
      feedAnthropicBody(input.detector, input.config, body);
      break;
    case "openai-responses":
      feedOpenAiResponsesBody(input.detector, input.config, body);
      break;
  }
  input.detector.finalize();
}
