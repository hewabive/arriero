import type { ApiProxyStreamTerminal } from "@arriero/core";

import { logger } from "../logger.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";

type ProxyStreamTerminal = ApiProxyStreamTerminal;

export type ProxyStreamHealth = {
  malformedChunks: number;
  malformedSample: string | null;
  terminal: ProxyStreamTerminal | null;
  truncationRetries: number;
};

const MALFORMED_SAMPLE_LIMIT = 200;

export function emptyProxyStreamHealth(): ProxyStreamHealth {
  return {
    malformedChunks: 0,
    malformedSample: null,
    terminal: null,
    truncationRetries: 0,
  };
}

export function noteMalformedPayload(
  health: ProxyStreamHealth,
  data: string,
): void {
  health.malformedChunks += 1;
  health.malformedSample ??= data.slice(0, MALFORMED_SAMPLE_LIMIT);
}

export function classifyProxyStreamTerminal(
  sawDone: boolean,
  sawFinish: boolean,
): ProxyStreamTerminal {
  return sawDone ? "done" : sawFinish ? "finish" : "eof";
}

export function markPlanTruncatedOnEof(
  responsePlan: { markTruncated: () => void } | null,
): (health: ProxyStreamHealth) => void {
  return (health) => {
    if (health.terminal === "eof") {
      responsePlan?.markTruncated();
    }
  };
}

function mergedTerminal(
  previous: ProxyStreamTerminal | null,
  next: ProxyStreamTerminal | null,
): ProxyStreamTerminal | null {
  if (previous === "eof" || next === "eof") {
    return "eof";
  }
  return next ?? previous;
}

export function applyProxyStreamHealth(input: {
  trace: ProxyTraceAccumulator;
  health: ProxyStreamHealth;
  targetName?: string | null | undefined;
}): void {
  const { health } = input;
  if (
    health.malformedChunks === 0 &&
    health.terminal === null &&
    health.truncationRetries === 0
  ) {
    return;
  }
  const previous = input.trace.streamHealth;
  const terminal = mergedTerminal(previous?.terminal ?? null, health.terminal);
  const truncated = terminal === "eof";
  input.trace.streamHealth = {
    malformedChunks: (previous?.malformedChunks ?? 0) + health.malformedChunks,
    terminal,
    truncated,
    truncationRetries:
      (previous?.truncationRetries ?? 0) + health.truncationRetries,
  };
  const targetName = input.targetName ?? input.trace.targetName;
  if (health.malformedChunks > 0) {
    logger.warn(
      {
        modelId: input.trace.modelId,
        targetName,
        malformedChunks: health.malformedChunks,
        sample: health.malformedSample,
      },
      "proxy stream contained malformed SSE data payloads",
    );
  }
  if (truncated) {
    logger.warn(
      {
        modelId: input.trace.modelId,
        targetName,
        truncationRetries: input.trace.streamHealth.truncationRetries,
      },
      "proxy stream ended without a terminal chunk",
    );
  }
}
