import {
  apiProxyClientAbortErrorCode,
  type ApiProxyRouteTraceStep,
  type ApiProxySchedulerAction,
  type ApiProxyTraceFile,
} from "@arriero/core";
import type { Context } from "hono";

import { newId } from "../utils/id.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolDiagnostic,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolOperation,
} from "./protocol.js";
import type { ResumableBufferState } from "./resumable-forward.js";
import { apiProxySlotTracker } from "./slot-tracker.js";

export type ProxyTraceAccumulator = {
  id: string;
  at: string;
  protocol: ApiProxyProtocolOperation["protocol"];
  translated: boolean;
  endpoint: string;
  routePath: string;
  modelId: string;
  sourceId: string | null;
  sourceName: string | null;
  stream: boolean | null;
  targetId: string | null;
  targetName: string | null;
  slotId: number | null;
  cacheOrigin: "live" | "restored" | "fresh" | null;
  cache: "hit" | "store" | "coalesced" | null;
  resumed: boolean;
  textReplacementCount: number;
  routeTrace: ApiProxyRouteTraceStep[];
  files: ApiProxyTraceFile[];
  schedulerActions: ApiProxySchedulerAction[];
  displacedTargetIds: string[];
  usage: {
    promptTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    completionTokens: number;
    genMs: number;
    ratePerSecond: number | null;
    prefillMs: number | null;
    promptPerSecond: number | null;
  } | null;
  streamHealth: {
    malformedChunks: number;
  } | null;
  status: number;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  translationWarnings: string[];
  durationMs: number;
  queueMs: number | null;
  ttftMs: number | null;
};

export type ProxyTraceRecorder = {
  record: (response: Response | undefined) => void;
  markDeferred: () => void;
  freezeDuration: () => void;
  beforeRecord: (hook: () => void) => void;
};

export function createProxyTrace(
  operation: ApiProxyProtocolOperation,
): ProxyTraceAccumulator {
  return {
    id: newId(),
    at: new Date().toISOString(),
    protocol: operation.protocol,
    translated: false,
    endpoint: operation.endpoint,
    routePath: operation.routePath,
    modelId: "",
    sourceId: null,
    sourceName: null,
    stream: null,
    targetId: null,
    targetName: null,
    slotId: null,
    cacheOrigin: null,
    cache: null,
    resumed: false,
    textReplacementCount: 0,
    routeTrace: [],
    files: [],
    schedulerActions: [],
    displacedTargetIds: [],
    usage: null,
    streamHealth: null,
    status: 0,
    ok: false,
    errorCode: null,
    errorMessage: null,
    translationWarnings: [],
    durationMs: 0,
    queueMs: null,
    ttftMs: null,
  };
}

export function applyTraceDiagnostic(
  trace: ProxyTraceAccumulator,
  diagnostic: { code: string; message: string },
): void {
  trace.errorCode = diagnostic.code;
  trace.errorMessage = diagnostic.message;
}

export function markTraceClientAbort(
  trace: ProxyTraceAccumulator,
  message: string,
): void {
  trace.errorCode = apiProxyClientAbortErrorCode;
  trace.errorMessage = message;
}

export function traceDiagnosticResponse(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  trace: ProxyTraceAccumulator;
  diagnostic: ApiProxyProtocolDiagnostic;
}): Response {
  applyTraceDiagnostic(input.trace, input.diagnostic);
  const response = input.adapter.diagnosticError(
    input.request,
    input.diagnostic,
  );
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    input.c.header(name, value);
  }
  return input.c.json(response.body, response.status);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorBodyMessage(body: unknown): string | null {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }
  return null;
}

export function upstreamErrorText(text: string): string {
  return errorBodyMessage(safeJsonParse(text)) ?? text.slice(0, 500);
}

const SERVER_TIMING_WAIT_MS = 1500;

export async function applyServerGenerationTiming(
  trace: ProxyTraceAccumulator,
  instanceId: string | null,
  task: number | null,
): Promise<void> {
  if (instanceId === null || task === null) {
    return;
  }
  const timing = await apiProxySlotTracker.awaitTiming(
    instanceId,
    task,
    SERVER_TIMING_WAIT_MS,
  );
  if (!timing) {
    return;
  }
  if (trace.usage) {
    trace.usage.genMs = Math.round(timing.genMs);
    trace.usage.ratePerSecond = timing.tokensPerSecond;
    if (timing.prefillMs !== null) {
      trace.usage.prefillMs = Math.round(timing.prefillMs);
    }
    if (timing.promptPerSecond !== null) {
      trace.usage.promptPerSecond = timing.promptPerSecond;
    }
    if (trace.usage.promptTokens === null && timing.promptTokens !== null) {
      trace.usage.promptTokens = timing.promptTokens;
    }
  } else {
    trace.usage = {
      promptTokens: timing.promptTokens,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      completionTokens: timing.completionTokens,
      genMs: Math.round(timing.genMs),
      ratePerSecond: timing.tokensPerSecond,
      prefillMs:
        timing.prefillMs === null ? null : Math.round(timing.prefillMs),
      promptPerSecond: timing.promptPerSecond,
    };
  }
}

export function recordTraceWithDeferredTiming(input: {
  recorder: ProxyTraceRecorder;
  trace: ProxyTraceAccumulator;
  instanceId: string | null;
  task: number | null;
  response: Response;
}): Response {
  input.recorder.markDeferred();
  input.recorder.freezeDuration();
  void applyServerGenerationTiming(
    input.trace,
    input.instanceId,
    input.task,
  ).finally(() => input.recorder.record(input.response));
  return input.response;
}

export function resumableTraceUsage(
  state: ResumableBufferState,
): NonNullable<ProxyTraceAccumulator["usage"]> {
  return {
    promptTokens: state.promptTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheCreationTokens: state.cacheCreationTokens,
    completionTokens: state.completionTokens,
    genMs: Math.round(state.genMs),
    ratePerSecond:
      state.completionTokens > 0 && state.genMs > 0
        ? state.completionTokens / (state.genMs / 1000)
        : null,
    prefillMs: null,
    promptPerSecond: null,
  };
}
