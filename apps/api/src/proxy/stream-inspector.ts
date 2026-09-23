import type {
  ApiProxyResumableCodec,
  ApiProxyResumableStreamChunk,
} from "./protocol.js";
import {
  classifyProxyStreamTerminal,
  emptyProxyStreamHealth,
  noteMalformedPayload,
  type ProxyStreamHealth,
} from "./stream-health.js";
import {
  createProxyChunkObserver,
  emptyProxyStreamUsageTally,
  type ProxyStreamObserver,
  type ProxyStreamUsageTally,
} from "./stream-observer.js";

type ProxyStreamInspection =
  | { type: "chunk"; chunk: ApiProxyResumableStreamChunk }
  | { type: "done" }
  | { type: "malformed" }
  | { type: "ignored" };

type ProxyStreamInspectionSnapshot = ProxyStreamUsageTally & {
  genMs: number;
  observedGenMs?: number;
  health: ProxyStreamHealth;
};

export type ProxyStreamInspector = {
  observeData(data: string, receivedAt?: number): ProxyStreamInspection;
  finish(): ProxyStreamInspectionSnapshot;
  snapshot(): ProxyStreamInspectionSnapshot;
};

export type ProxyStreamInspectionOptions = {
  estimateRate?: boolean | undefined;
  now?: (() => number) | undefined;
};

export function createProxyStreamInspector(
  input: ProxyStreamInspectionOptions & {
    codec: Pick<ApiProxyResumableCodec, "parseChunk">;
    observer?: ProxyStreamObserver | undefined;
    usage?: ProxyStreamUsageTally | undefined;
    health?: ProxyStreamHealth | undefined;
  },
): ProxyStreamInspector {
  const health = input.health ?? emptyProxyStreamHealth();
  const usage = input.usage ?? emptyProxyStreamUsageTally();
  const observeChunk = createProxyChunkObserver(input.observer ?? {}, usage);
  const now = input.now ?? (() => performance.now());
  let firstOutputAt: number | null = null;
  let lastOutputAt: number | null = null;
  let upstreamGenMs: number | null = null;
  let sawDone = false;
  let sawFinish = false;
  let ended = false;

  const observedTiming = (): { observedGenMs?: number } => {
    if (
      !input.estimateRate ||
      upstreamGenMs !== null ||
      (!sawDone && !sawFinish) ||
      health.malformedChunks > 0 ||
      usage.completionTokens <= 1 ||
      firstOutputAt === null ||
      lastOutputAt === null
    )
      return {};
    const observedGenMs = Math.round(lastOutputAt - firstOutputAt);
    return observedGenMs > 0 ? { observedGenMs } : {};
  };

  const snapshot = (): ProxyStreamInspectionSnapshot => ({
    ...observedTiming(),
    ...usage,
    genMs: upstreamGenMs === null ? 0 : Math.round(upstreamGenMs),
    health: {
      ...health,
      terminal:
        ended || sawDone || sawFinish
          ? classifyProxyStreamTerminal(sawDone, sawFinish)
          : null,
    },
  });

  return {
    observeData(data, receivedAt) {
      const parsed = input.codec.parseChunk(data);
      if (parsed === "malformed") {
        noteMalformedPayload(health, data);
        return { type: "malformed" };
      }
      if (parsed === "done") {
        sawDone = true;
        return { type: "done" };
      }
      if (parsed === null) {
        return { type: "ignored" };
      }
      if (
        input.estimateRate &&
        !sawDone &&
        !sawFinish &&
        (parsed.text !== "" ||
          Boolean(parsed.reasoning) ||
          parsed.toolCalls?.some((call) =>
            Boolean(call.name || call.arguments),
          ))
      ) {
        const at = receivedAt ?? now();
        firstOutputAt ??= at;
        lastOutputAt = at;
      }
      if (parsed.finishReason !== null) {
        sawFinish = true;
      }
      if (typeof parsed.genMs === "number") {
        upstreamGenMs = parsed.genMs;
      }
      observeChunk(parsed);
      return { type: "chunk", chunk: parsed };
    },
    finish() {
      ended = true;
      return snapshot();
    },
    snapshot,
  };
}
