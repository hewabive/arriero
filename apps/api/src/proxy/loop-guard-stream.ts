import type { ApiProxyLoopGuardConfig } from "@arriero/core";
import { isRecord, type JsonRecord } from "./json.js";
import type {
  ApiProxyLoopGuardDetector,
  ApiProxyLoopGuardHit,
  ApiProxyLoopGuardLane,
} from "./loop-guard.js";
import {
  apiProxyResponseShape,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { safeJsonParse } from "./protocol-trace.js";
import {
  apiProxySseDataFrame,
  apiProxySseEventFrame,
  createApiProxySseFrameBuffer,
  createApiProxySseTransform,
  parseApiProxySseJsonFrame,
  transformApiProxySseText,
  type ApiProxySseFrameTransformer,
} from "./response-codec.js";
import {
  collectMutableDeltas,
  visitApiProxyResponseTextSurfaces,
} from "./response-replace.js";

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

function feedLane(
  detector: ApiProxyLoopGuardDetector,
  config: ApiProxyLoopGuardConfig,
  lane: ApiProxyLoopGuardLane,
  text: unknown,
): ApiProxyLoopGuardHit | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (!laneEnabled(lane, config)) {
    return null;
  }
  return detector.append(lane, text);
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

type LoopGuardScanInput = {
  operation: ApiProxyProtocolOperation;
  config: ApiProxyLoopGuardConfig;
  detector: ApiProxyLoopGuardDetector;
};

function createFrameScanner(
  input: LoopGuardScanInput,
  onPayload?: (value: unknown) => void,
): (frame: string) => ApiProxyLoopGuardHit | null {
  const channels = {
    includeReasoning: input.config.reasoning,
    includeToolArguments: input.config.toolArguments,
  };
  return (frame) => {
    const parsed = parseApiProxySseJsonFrame(frame);
    let hit: ApiProxyLoopGuardHit | null = null;
    for (const payload of parsed.payloads) {
      onPayload?.(payload.value);
      for (const delta of collectMutableDeltas(
        payload.value,
        input.operation,
        channels,
      )) {
        hit ??= feedLane(
          input.detector,
          input.config,
          delta.channel,
          delta.text,
        );
      }
    }
    return hit;
  };
}

function createObserveStream(
  input: LoopGuardStreamInput,
): TransformStream<Uint8Array, Uint8Array> {
  const frames = createApiProxySseFrameBuffer();
  const scan = createFrameScanner(input);
  let latched = false;
  const scanFrames = (list: string[]) => {
    for (const frame of list) {
      if (latched) {
        return;
      }
      latched = scan(frame) !== null;
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!latched) {
        scanFrames(frames.push(chunk));
      }
    },
    flush() {
      if (latched) {
        return;
      }
      const tail = frames.flush();
      if (tail !== null) {
        scanFrames([tail]);
      }
    },
  });
}

function createFinishTransformer(
  input: LoopGuardStreamInput,
): ApiProxySseFrameTransformer {
  const shape = apiProxyResponseShape(input.operation);
  const openBlocks = new Set<number>();
  let maxBlockIndex = -1;
  let chatEnvelope: ChatEnvelope | null = null;

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

  const marker =
    input.config.markerText.length > 0 ? `\n\n${input.config.markerText}` : "";

  const finishFrames = (): string[] => {
    if (shape === "anthropic") {
      const output: string[] = [];
      for (const index of [...openBlocks].sort((a, b) => a - b)) {
        output.push(
          apiProxySseEventFrame("content_block_stop", {
            type: "content_block_stop",
            index,
          }),
        );
      }
      if (marker) {
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
            delta: { type: "text_delta", text: marker },
          }),
          apiProxySseEventFrame("content_block_stop", {
            type: "content_block_stop",
            index,
          }),
        );
      }
      const outputTokens = Math.max(
        1,
        Math.round(input.detector.snapshot().scannedChars / 4),
      );
      output.push(
        apiProxySseEventFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
        apiProxySseEventFrame("message_stop", { type: "message_stop" }),
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
      apiProxySseDataFrame({ ...envelope, ...extra });
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

  const scan = createFrameScanner(input, trackShapeState);

  return {
    transform(frame) {
      const hit = scan(frame);
      if (!hit) {
        return frame;
      }
      input.onFinished?.(hit);
      return { frames: [frame, ...finishFrames()], terminate: true };
    },
  };
}

export function createApiProxyLoopGuardStream(
  input: LoopGuardStreamInput,
): TransformStream<Uint8Array, Uint8Array> {
  const enforce =
    input.config.action === "finish" &&
    apiProxyLoopGuardFinishSupported(input.operation);
  if (!enforce) {
    return createObserveStream(input);
  }
  return createApiProxySseTransform(createFinishTransformer(input));
}

export function feedApiProxyLoopGuardText(input: {
  detector: ApiProxyLoopGuardDetector;
  config: ApiProxyLoopGuardConfig;
  operation: ApiProxyProtocolOperation;
  text: string;
  isSse: boolean;
}): void {
  if (input.isSse) {
    const scan = createFrameScanner(input);
    transformApiProxySseText(input.text, {
      transform: (frame) => {
        scan(frame);
        return null;
      },
    });
  } else {
    const body = safeJsonParse(input.text);
    if (!isRecord(body)) {
      return;
    }
    visitApiProxyResponseTextSurfaces(
      body,
      input.operation,
      (channel, text) => {
        feedLane(input.detector, input.config, channel, text);
      },
    );
  }
  input.detector.finalize();
}
