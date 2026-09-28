import type { ApiProxyLoopGuardConfig } from "@arriero/core";
import { isRecord } from "./json.js";
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
import {
  apiProxyClosableShape,
  createApiProxySseTerminalTracker,
  type ApiProxyClosableShape,
} from "./sse-terminal.js";

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
  shape: ApiProxyClosableShape,
): ApiProxySseFrameTransformer {
  const tracker = createApiProxySseTerminalTracker(shape);
  const marker =
    input.config.markerText.length > 0 ? `\n\n${input.config.markerText}` : "";
  const scan = createFrameScanner(input, tracker.observe);

  return {
    transform(frame) {
      const hit = scan(frame);
      if (!hit) {
        return frame;
      }
      input.onFinished?.(hit);
      const closing = tracker.closingFrames({
        reason: "length",
        syntheticIdSuffix: "loop-guard",
        marker,
        outputTokens: Math.max(
          1,
          Math.round(input.detector.snapshot().scannedChars / 4),
        ),
      });
      return { frames: [frame, ...closing], terminate: true };
    },
  };
}

export function createApiProxyLoopGuardStream(
  input: LoopGuardStreamInput,
): TransformStream<Uint8Array, Uint8Array> {
  const finishShape =
    input.config.action === "finish"
      ? apiProxyClosableShape(apiProxyResponseShape(input.operation))
      : null;
  if (!finishShape) {
    return createObserveStream(input);
  }
  return createApiProxySseTransform(
    createFinishTransformer(input, finishShape),
  );
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
