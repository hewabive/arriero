import {
  apiProxyClientAbortErrorCode,
  type ApiEndpointStreamTerminal,
  type ApiProxyRouteTraceStep,
  type ApiProxySchedulerAction,
  type ApiProxyTraceFile,
  type ApiProxyTraceUsage,
  type ApiProxyTraceStreamHealth,
} from "@arriero/core";
import type { Context } from "hono";

import { newId } from "../utils/id.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolDiagnostic,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolOperation,
  ApiProxyResumableCodec,
} from "./protocol.js";
import { CLIENT_ABORT_STATUS } from "./http.js";
import {
  finalFromState,
  partialFromState,
  type ConsumeResumableSseOutcome,
  type ResumableBufferState,
} from "./resumable-forward.js";
import {
  applyApiProxyResponsePlanText,
  type ApiProxyResponsePlanExecutor,
} from "./response-plan.js";
import {
  ratePerSecondFromUsage,
  usageFromNonStreamBody,
  type ProxyUsageCounts,
} from "./usage-meter.js";
import { applyProxyStreamHealth } from "./stream-health.js";
import { apiProxySlotTracker } from "./slot-tracker.js";
import { translateOpenAiErrorText } from "./translation.js";

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
  usage: ApiProxyTraceUsage | null;
  streamHealth: ApiProxyTraceStreamHealth | null;
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
  record: (response: Pick<Response, "status"> | undefined) => void;
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

type PartialResponseBody = () => string | null;

export function capturePartialResponse(
  responsePlan: ApiProxyResponsePlanExecutor | null | undefined,
  partialBody: PartialResponseBody | null | undefined,
): void {
  if (!responsePlan || !partialBody) {
    return;
  }
  const text = partialBody();
  if (text) {
    responsePlan.capturePartial(text);
  }
}

export function upstreamErrorDiagnostic(
  message: string,
): ApiProxyProtocolDiagnostic {
  return {
    status: 502,
    code: "arriero_proxy_upstream_error",
    param: "model",
    message,
  };
}

export function clientAbortResponse(input: {
  trace: ProxyTraceAccumulator;
  message: string;
  responsePlan: ApiProxyResponsePlanExecutor | null;
  partialBody: PartialResponseBody | null;
}): Response {
  markTraceClientAbort(input.trace, input.message);
  capturePartialResponse(input.responsePlan, input.partialBody);
  return new Response(null, { status: CLIENT_ABORT_STATUS });
}

export function traceDiagnosticResponse(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  trace: ProxyTraceAccumulator;
  diagnostic: ApiProxyProtocolDiagnostic;
  responsePlan?: ApiProxyResponsePlanExecutor | null | undefined;
  partialBody?: PartialResponseBody | null | undefined;
}): Response {
  applyTraceDiagnostic(input.trace, input.diagnostic);
  capturePartialResponse(input.responsePlan, input.partialBody);
  const response = input.adapter.diagnosticError(
    input.request,
    input.diagnostic,
  );
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    input.c.header(name, value);
  }
  input.responsePlan?.processText(JSON.stringify(response.body), {
    status: response.status,
    contentType: "application/json",
    isSse: false,
  });
  return input.c.json(response.body, response.status);
}

function truncatedStreamResponse(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  trace: ProxyTraceAccumulator;
  codec: ApiProxyResumableCodec;
  state: ResumableBufferState;
  label: string;
  responsePlan?: ApiProxyResponsePlanExecutor | null;
}): Response {
  applyProxyStreamHealth({ trace: input.trace, health: input.state.health });
  return traceDiagnosticResponse({
    c: input.c,
    adapter: input.adapter,
    request: input.request,
    trace: input.trace,
    responsePlan: input.responsePlan ?? null,
    partialBody: () => partialFromState(input.codec, input.state),
    diagnostic: upstreamErrorDiagnostic(
      `${input.label} ended without a terminal chunk (${input.state.text.length} chars buffered).`,
    ),
  });
}

export function bufferedSseFailureResponse(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  trace: ProxyTraceAccumulator;
  responsePlan: ApiProxyResponsePlanExecutor | null;
  codec: ApiProxyResumableCodec;
  state: ResumableBufferState;
  outcome: ConsumeResumableSseOutcome;
  omittedCacheReadIsZero: boolean;
  clientAbortMessage: string;
  failure: (detail: string) => ApiProxyProtocolDiagnostic;
  truncatedLabel: string;
  streamTerminal: ApiEndpointStreamTerminal;
}): Response | null {
  const { trace, responsePlan, codec, state, outcome } = input;
  trace.usage = resumableTraceUsage(state, input.omittedCacheReadIsZero);
  const partialBody = () => partialFromState(codec, state);
  if (outcome.type === "consumer-gone" || outcome.type === "cancelled") {
    return clientAbortResponse({
      trace,
      message: input.clientAbortMessage,
      responsePlan,
      partialBody,
    });
  }
  if (outcome.type === "error") {
    return traceDiagnosticResponse({
      c: input.c,
      adapter: input.adapter,
      request: input.request,
      trace,
      diagnostic: input.failure(outcome.message),
      responsePlan,
      partialBody,
    });
  }
  if (outcome.type === "truncated") {
    if (input.streamTerminal === "strict") {
      return truncatedStreamResponse({
        c: input.c,
        adapter: input.adapter,
        request: input.request,
        trace,
        codec,
        state,
        label: input.truncatedLabel,
        responsePlan,
      });
    }
    responsePlan?.markTruncated();
  }
  applyProxyStreamHealth({ trace, health: state.health });
  return null;
}

export function bufferedSseResponse(
  codec: ApiProxyResumableCodec,
  state: ResumableBufferState,
  responsePlan: ApiProxyResponsePlanExecutor | null,
): Response {
  const final = finalFromState(codec, state, false);
  const delivered = applyApiProxyResponsePlanText(responsePlan, final.body, {
    status: final.status,
    contentType: final.headers["content-type"] ?? "application/json",
    isSse: false,
  });
  return new Response(delivered, {
    status: final.status,
    headers: final.headers,
  });
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

export function recordUpstreamErrorBody(
  trace: ProxyTraceAccumulator,
  protocol: ApiProxyProtocolOperation["protocol"],
  text: string,
  omittedCacheReadIsZero: boolean,
): void {
  const usage = usageFromNonStreamBody(protocol, text);
  if (usage) {
    trace.usage = traceUsageFromCounts(usage, omittedCacheReadIsZero);
  }
  if (text) {
    trace.errorMessage = upstreamErrorText(text);
  }
}

export function translatedUpstreamError(
  status: number,
  text: string,
  translate: boolean,
): { headers: Record<string, string>; body: string } | null {
  return translate
    ? {
        headers: { "content-type": "application/json" },
        body: translateOpenAiErrorText(status, text),
      }
    : null;
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
    delete trace.usage.rateSource;
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

export function traceUsageFromCounts(
  usage: ProxyUsageCounts,
  omittedCacheReadIsZero = false,
): NonNullable<ProxyTraceAccumulator["usage"]> {
  const observedGenMs = usage.observedGenMs ?? 0;
  const estimated = usage.genMs === 0 && observedGenMs > 0;
  const genMs = estimated ? observedGenMs : usage.genMs;
  return {
    promptTokens: usage.promptTokens,
    cacheReadTokens:
      usage.cacheReadTokens ??
      (omittedCacheReadIsZero && usage.promptTokens !== null ? 0 : null),
    cacheCreationTokens: usage.cacheCreationTokens,
    completionTokens: usage.completionTokens,
    genMs: Math.round(genMs),
    ratePerSecond: ratePerSecondFromUsage({ ...usage, genMs }),
    ...(estimated ? { rateSource: "proxy" as const } : {}),
    prefillMs: usage.prefillMs,
    promptPerSecond: usage.promptPerSecond,
  };
}

export function resumableTraceUsage(
  state: ResumableBufferState,
  omittedCacheReadIsZero = false,
): NonNullable<ProxyTraceAccumulator["usage"]> {
  return traceUsageFromCounts(
    { ...state, prefillMs: null, promptPerSecond: null },
    omittedCacheReadIsZero,
  );
}
