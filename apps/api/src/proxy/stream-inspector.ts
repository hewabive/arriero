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
  health: ProxyStreamHealth;
};

export type ProxyStreamInspector = {
  observeData(data: string): ProxyStreamInspection;
  finish(): ProxyStreamInspectionSnapshot;
  snapshot(): ProxyStreamInspectionSnapshot;
};

export function createProxyStreamInspector(input: {
  codec: Pick<ApiProxyResumableCodec, "parseChunk">;
  observer?: ProxyStreamObserver | undefined;
  usage?: ProxyStreamUsageTally | undefined;
  health?: ProxyStreamHealth | undefined;
}): ProxyStreamInspector {
  const health = input.health ?? emptyProxyStreamHealth();
  const usage = input.usage ?? emptyProxyStreamUsageTally();
  const observeChunk = createProxyChunkObserver(input.observer ?? {}, usage);
  let upstreamGenMs: number | null = null;
  let sawDone = false;
  let sawFinish = false;
  let ended = false;

  const snapshot = (): ProxyStreamInspectionSnapshot => ({
    ...usage,
    genMs: upstreamGenMs === null ? 0 : Math.round(upstreamGenMs),
    health: {
      ...health,
      terminal: ended ? classifyProxyStreamTerminal(sawDone, sawFinish) : null,
    },
  });

  return {
    observeData(data) {
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
