import type { ApiProxyTargetRecord } from "@arriero/core";
import type { Context } from "hono";

import { proxyUpstreamFetch } from "./http.js";
import type { ApiProxyInflightHandle } from "./inflight.js";
import {
  apiProxyPendingResume,
  type ApiProxyPendingResumeEntry,
  type ApiProxyPendingResumeStore,
} from "./pending-resume.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
} from "./protocol.js";
import {
  bufferedSseFailureResponse,
  bufferedSseResponse,
  traceUsageFromCounts,
  upstreamErrorDiagnostic,
  type ProxyTraceAccumulator,
  type ProxyTraceRecorder,
} from "./protocol-trace.js";
import type { ApiProxyResponsePlanExecutor } from "./response-plan.js";
import {
  consumeResumableSse,
  createResumableBufferState,
} from "./resumable-forward.js";
import {
  applyProxyStreamHealth,
  markPlanTruncatedOnEof,
} from "./stream-health.js";
import { deliverApiProxySseResponse } from "./stream-delivery.js";
import { apiProxyStreamFailureDiagnostic } from "./stream-errors.js";
import { watchStreamIdle } from "./stream-idle.js";
import { inflightStreamObserver } from "./stream-observer.js";
import {
  prepareApiProxyUpstreamRequest,
  type ApiProxyUpstreamRequest,
} from "./reasoning-request.js";
import {
  apiProxyStreamResumeKey,
  apiProxyStreamSessionUrl,
} from "./stream-session.js";
import {
  createAnthropicTranslationStream,
  translatedAnthropicResumableCodec,
} from "./translation.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";
import {
  createUsageMeterStream,
  includeUsageRequested,
  requestBreaksStreamReconstruction,
  returnProgressRequested,
  type ProxyUsageCounts,
} from "./usage-meter.js";

export type ApiProxyResumeClaim = {
  entry: ApiProxyPendingResumeEntry;
  baseUrl: string;
  authHeaders: Record<string, string>;
  translateAnthropic: boolean;
  exchangeBody: unknown;
  codec: ApiProxyResumableCodec;
  streamIdleTimeoutMs: number | null;
};

export function apiProxyForwardResumeKey(input: {
  instanceId: string;
  forward: ApiProxyUpstreamRequest;
  modelOverride: string | null;
  modelId: string;
}): string {
  return apiProxyStreamResumeKey({
    instanceId: input.instanceId,
    path: input.forward.path,
    modelId: input.modelOverride ?? input.modelId,
    body: input.forward.body,
  });
}

export function claimApiProxyResumedSession(input: {
  operation: ApiProxyProtocolOperation;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  target: ApiProxyTargetRecord | null;
  headers: Headers;
  store?: ApiProxyPendingResumeStore;
}): ApiProxyResumeClaim | null {
  const store = input.store ?? apiProxyPendingResume;
  if (store.size() === 0) {
    return null;
  }
  if (!apiProxyOperationSpec(input.operation)?.resumable) {
    return null;
  }
  const codec = input.adapter.resumable;
  const upstreamPath = input.adapter.upstreamPath(input.operation);
  if (!codec || !upstreamPath || !input.target) {
    return null;
  }
  if (
    !input.request.stream &&
    requestBreaksStreamReconstruction(input.request.body)
  ) {
    return null;
  }
  const resolved = resolveApiProxyUpstreamContext({
    target: input.target,
    operation: input.operation,
  });
  if (!resolved.ok || resolved.context.instanceId === null) {
    return null;
  }
  const forward = prepareApiProxyUpstreamRequest({
    context: resolved.context,
    operation: input.operation,
    path: upstreamPath,
    body: input.request.body,
    headers: input.headers,
  });
  const entry = store.claim(
    apiProxyForwardResumeKey({
      instanceId: resolved.context.instanceId,
      forward,
      modelOverride: resolved.context.modelOverride,
      modelId: input.request.modelId,
    }),
  );
  if (!entry) {
    return null;
  }
  return {
    entry,
    baseUrl: resolved.context.baseUrl,
    authHeaders: resolved.context.authHeaders,
    translateAnthropic: resolved.context.translateAnthropic,
    exchangeBody: forward.body,
    codec,
    streamIdleTimeoutMs: resolved.context.streamIdleTimeoutMs,
  };
}

export async function serveResumedStreamSession(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  claim: ApiProxyResumeClaim;
  trace: ProxyTraceAccumulator;
  recorder: ProxyTraceRecorder;
  inflight: ApiProxyInflightHandle;
  responsePlan: ApiProxyResponsePlanExecutor | null;
  streamOwnerKey?: string | null | undefined;
  fetchImpl?: typeof proxyUpstreamFetch;
  store?: ApiProxyPendingResumeStore;
}): Promise<Response | null> {
  const { c, request, claim, trace, recorder, inflight } = input;
  const { entry, baseUrl, authHeaders, translateAnthropic, codec } = claim;
  const fetchImpl = input.fetchImpl ?? proxyUpstreamFetch;
  const store = input.store ?? apiProxyPendingResume;

  const url = apiProxyStreamSessionUrl({
    baseUrl,
    convId: entry.convId,
    from: 0,
  });
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "GET",
      headers: authHeaders,
      signal: c.req.raw.signal,
    });
  } catch {
    store.finish(entry, { evict: false });
    return null;
  }
  if (!upstream.ok || !upstream.body) {
    void upstream.text().catch(() => "");
    store.finish(entry, { evict: upstream.status === 400 });
    return null;
  }

  trace.resumed = true;
  inflight.dispatched();
  const guardedBody = watchStreamIdle(
    upstream.body,
    claim.streamIdleTimeoutMs,
    (error) => {
      trace.errorCode = "arriero_proxy_upstream_timeout";
      trace.errorMessage = `Resumed stream replay: ${error.message}`;
    },
  );
  const effectiveCodec = translateAnthropic
    ? translatedAnthropicResumableCodec(claim.exchangeBody)
    : codec;
  const applyUsage = (usage: ProxyUsageCounts) => {
    trace.usage = traceUsageFromCounts(usage);
  };
  const observer = inflightStreamObserver(inflight);

  if (!request.stream) {
    const state = createResumableBufferState();
    const outcome = await consumeResumableSse({
      body: guardedBody,
      codec: effectiveCodec,
      state,
      consumerSignal: c.req.raw.signal,
      finishSignal: inflight.controlSignal("finish"),
      cancelSignal: inflight.controlSignal("cancel"),
      ...observer,
    });
    store.finish(entry, { evict: true });
    return (
      bufferedSseFailureResponse({
        c,
        adapter: input.adapter,
        request,
        trace,
        responsePlan: input.responsePlan,
        codec: effectiveCodec,
        state,
        outcome,
        omittedCacheReadIsZero: false,
        clientAbortMessage:
          "Client closed the request before the resumed stream replay finished",
        failure: (detail) =>
          upstreamErrorDiagnostic(`Resumed stream replay failed: ${detail}`),
        truncatedLabel: "Resumed stream replay",
        streamTerminal: "strict",
      }) ?? bufferedSseResponse(effectiveCodec, state, input.responsePlan)
    );
  }

  let metered: Response | undefined;
  const onStreamComplete = (usage: ProxyUsageCounts) => {
    recorder.freezeDuration();
    applyUsage(usage);
  };
  const deliverStream = (
    body: ReadableStream<Uint8Array>,
    onSettled: () => void,
  ): Response =>
    deliverApiProxySseResponse({
      body,
      status: upstream.status,
      headers: upstream.headers,
      adapter: input.adapter,
      request,
      trace,
      responsePlan: input.responsePlan,
      streamOwnerKey: input.streamOwnerKey ?? null,
      onSettled,
      onError: (error) =>
        c.req.raw.signal.aborted
          ? null
          : apiProxyStreamFailureDiagnostic("Resumed stream replay", error),
    });

  if (translateAnthropic) {
    const translation = createAnthropicTranslationStream({
      ...observer,
      onStreamEnd: (health) => {
        markPlanTruncatedOnEof(input.responsePlan)(health);
        applyProxyStreamHealth({ trace, health });
      },
      onComplete: onStreamComplete,
    });
    recorder.markDeferred();
    metered = deliverStream(
      guardedBody.pipeThrough(translation.transform),
      () => {
        store.finish(entry, { evict: true });
        translation.finalize();
        recorder.record(metered);
      },
    );
    return metered;
  }

  const meter = createUsageMeterStream({
    codec,
    stripUsageFrames: !includeUsageRequested(request.body),
    stripProgressFrames: !returnProgressRequested(claim.exchangeBody),
    onStreamEnd: markPlanTruncatedOnEof(input.responsePlan),
    ...observer,
    onComplete: onStreamComplete,
  });
  recorder.markDeferred();
  metered = deliverStream(guardedBody.pipeThrough(meter.transform), () => {
    store.finish(entry, { evict: true });
    applyProxyStreamHealth({ trace, health: meter.health() });
    meter.finalize();
    recorder.record(metered);
  });
  return metered;
}
