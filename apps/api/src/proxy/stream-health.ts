import { logger } from "../logger.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";
import type { ResumableBufferState } from "./resumable-forward.js";

export type ProxyStreamHealth = {
  malformedChunks: number;
  malformedSample: string | null;
};

const MALFORMED_SAMPLE_LIMIT = 200;

export function emptyProxyStreamHealth(): ProxyStreamHealth {
  return { malformedChunks: 0, malformedSample: null };
}

export function noteMalformedPayload(
  health: ProxyStreamHealth,
  data: string,
): void {
  health.malformedChunks += 1;
  health.malformedSample ??= data.slice(0, MALFORMED_SAMPLE_LIMIT);
}

export function proxyStreamHealthFromState(
  state: ResumableBufferState,
): ProxyStreamHealth {
  return {
    malformedChunks: state.health.malformedChunks,
    malformedSample: state.health.malformedSample,
  };
}

export function applyProxyStreamHealth(input: {
  trace: ProxyTraceAccumulator;
  health: ProxyStreamHealth;
  targetName?: string | null | undefined;
}): void {
  if (input.health.malformedChunks === 0) {
    return;
  }
  const previous = input.trace.streamHealth?.malformedChunks ?? 0;
  input.trace.streamHealth = {
    malformedChunks: previous + input.health.malformedChunks,
  };
  logger.warn(
    {
      modelId: input.trace.modelId,
      targetName: input.targetName ?? input.trace.targetName,
      malformedChunks: input.health.malformedChunks,
      sample: input.health.malformedSample,
    },
    "proxy stream contained malformed SSE data payloads",
  );
}
