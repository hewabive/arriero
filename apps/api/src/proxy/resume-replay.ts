import type { ApiProxyTargetRecord } from "@arriero/core";
import type { Context } from "hono";

import { CLIENT_ABORT_STATUS, proxyUpstreamFetch } from "./http.js";
import type { ApiProxyInflightHandle } from "./inflight.js";
import {
  apiProxyPendingResume,
  type ApiProxyPendingResumeEntry,
  type ApiProxyPendingResumeStore,
} from "./pending-resume.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolOperation,
  ApiProxyResumableCodec,
} from "./protocol.js";
import {
  resumableTraceUsage,
  traceDiagnosticResponse,
  type ProxyTraceAccumulator,
  type ProxyTraceRecorder,
} from "./protocol-trace.js";
import { observeBodyCompletion } from "./body-completion.js";
import {
  applyApiProxyResponsePlanText,
  tapApiProxyResponsePlanStream,
  type ApiProxyResponsePlanExecutor,
} from "./response-plan.js";
import {
  consumeResumableSse,
  createResumableBufferState,
  finalFromState,
} from "./resumable-forward.js";
import {
  applyProxyStreamHealth,
  proxyStreamHealthFromState,
} from "./stream-health.js";
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
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
  ratePerSecondFromUsage,
  requestBreaksStreamReconstruction,
  returnProgressRequested,
  type ProxyUsageCounts,
} from "./usage-meter.js";

const replayableEndpoints = new Set(["chat.completions", "messages"]);

export type ApiProxyResumeClaim = {
  entry: ApiProxyPendingResumeEntry;
  baseUrl: string;
  authHeaders: Record<string, string>;
  translateAnthropic: boolean;
  exchangeBody: unknown;
  codec: ApiProxyResumableCodec;
};

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
  if (!replayableEndpoints.has(input.operation.endpoint)) {
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
    translate: resolved.context.translateAnthropic,
    operation: input.operation,
    path: upstreamPath,
    body: input.request.body,
    headers: input.headers,
    instanceId: resolved.context.instanceId,
    endpointId: resolved.context.endpointId,
  });
  const entry = store.claim(
    apiProxyStreamResumeKey({
      instanceId: resolved.context.instanceId,
      path: forward.path,
      modelId: input.target.model ?? input.request.modelId,
      body: forward.body,
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
  const effectiveCodec = translateAnthropic
    ? translatedAnthropicResumableCodec(claim.exchangeBody)
    : codec;
  const applyUsage = (usage: ProxyUsageCounts) => {
    trace.usage = {
      promptTokens: usage.promptTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      completionTokens: usage.completionTokens,
      genMs: Math.round(usage.genMs),
      ratePerSecond: ratePerSecondFromUsage(usage),
      prefillMs: usage.prefillMs,
      promptPerSecond: usage.promptPerSecond,
    };
  };

  if (!request.stream) {
    const state = createResumableBufferState();
    const outcome = await consumeResumableSse({
      body: upstream.body,
      codec: effectiveCodec,
      state,
      consumerSignal: c.req.raw.signal,
      finishSignal: inflight.finishSignal(),
      cancelSignal: inflight.cancelSignal(),
      onFirstToken: (promptTokens) => inflight.firstToken(promptTokens),
      onReasoning: () => inflight.firstReasoning(),
      onReasoningDelta: (text) => inflight.appendReasoning(text),
      onAnswerDelta: (text) => inflight.appendAnswer(text),
      onToolCall: (delta) => inflight.appendToolCall(delta),
      onProgress: (tokens) => inflight.setCompletionTokens(tokens),
    });
    store.finish(entry, { evict: true });
    if (outcome.type === "consumer-gone" || outcome.type === "cancelled") {
      return new Response(null, { status: CLIENT_ABORT_STATUS });
    }
    if (outcome.type === "error") {
      return traceDiagnosticResponse({
        c,
        adapter: input.adapter,
        request,
        trace,
        diagnostic: {
          status: 502,
          code: "arriero_proxy_upstream_error",
          param: "model",
          message: `Resumed stream replay failed: ${outcome.message}`,
        },
      });
    }
    if (outcome.type === "truncated") {
      applyProxyStreamHealth({
        trace,
        health: proxyStreamHealthFromState(state),
      });
      return traceDiagnosticResponse({
        c,
        adapter: input.adapter,
        request,
        trace,
        diagnostic: {
          status: 502,
          code: "arriero_proxy_upstream_error",
          param: "model",
          message: `Resumed stream replay ended without a terminal chunk (${state.text.length} chars buffered).`,
        },
      });
    }
    trace.usage = resumableTraceUsage(state);
    applyProxyStreamHealth({
      trace,
      health: proxyStreamHealthFromState(state),
    });
    const final = finalFromState(effectiveCodec, state, false);
    const delivered = applyApiProxyResponsePlanText(
      input.responsePlan,
      final.body,
      {
        status: final.status,
        contentType: final.headers["content-type"] ?? "application/json",
        isSse: false,
      },
    );
    return new Response(delivered, {
      status: final.status,
      headers: final.headers,
    });
  }

  let metered: Response | undefined;
  const onStreamComplete = (usage: ProxyUsageCounts) => {
    recorder.freezeDuration();
    applyUsage(usage);
    recorder.record(metered);
  };

  if (translateAnthropic) {
    const translation = createAnthropicTranslationStream({
      onFirstToken: (promptTokens) => inflight.firstToken(promptTokens),
      onReasoning: () => inflight.firstReasoning(),
      onReasoningDelta: (text) => inflight.appendReasoning(text),
      onAnswerDelta: (text) => inflight.appendAnswer(text),
      onProgress: (tokens) => inflight.setCompletionTokens(tokens),
      onComplete: onStreamComplete,
    });
    recorder.markDeferred();
    metered = new Response(
      observeBodyCompletion(
        tapApiProxyResponsePlanStream(
          input.responsePlan,
          upstream.body.pipeThrough(translation.transform),
          upstream.status,
          upstream.headers,
        ),
        () => {
          store.finish(entry, { evict: true });
          translation.finalize();
        },
      ),
      { status: upstream.status, headers: upstream.headers },
    );
    return metered;
  }

  const meter = createUsageMeterStream({
    codec,
    stripUsageFrames: !includeUsageRequested(request.body),
    stripProgressFrames: !returnProgressRequested(claim.exchangeBody),
    onStreamEnd: (health) => {
      if (health.terminal === "eof") {
        input.responsePlan?.markTruncated();
      }
    },
    onFirstToken: (promptTokens) => inflight.firstToken(promptTokens),
    onReasoning: () => inflight.firstReasoning(),
    onReasoningDelta: (text) => inflight.appendReasoning(text),
    onAnswerDelta: (text) => inflight.appendAnswer(text),
    onToolCall: (delta) => inflight.appendToolCall(delta),
    onProgress: (tokens) => inflight.setCompletionTokens(tokens),
    onComplete: onStreamComplete,
  });
  recorder.markDeferred();
  metered = new Response(
    observeBodyCompletion(
      tapApiProxyResponsePlanStream(
        input.responsePlan,
        upstream.body.pipeThrough(meter.transform),
        upstream.status,
        upstream.headers,
      ),
      () => {
        store.finish(entry, { evict: true });
        applyProxyStreamHealth({ trace, health: meter.health() });
        meter.finalize();
      },
    ),
    { status: upstream.status, headers: upstream.headers },
  );
  return metered;
}
