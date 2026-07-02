import type { ApiProxyTargetRecord } from "@llama-manager/core";
import type { Context } from "hono";

import { apiProxyForwardUrl } from "./forwarder.js";
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
  type ProxyTraceAccumulator,
  type ProxyTraceRecorder,
} from "./protocol-trace.js";
import { observeBodyCompletion } from "./body-completion.js";
import type { ApiProxyResponseCaptureSink } from "./response-capture.js";
import {
  consumeResumableSse,
  createResumableBufferState,
  finalFromState,
} from "./resumable-forward.js";
import { apiProxyStreamResumeKey } from "./stream-session.js";
import {
  createAnthropicTranslationStream,
  prepareUpstreamExchange,
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
  const exchange = prepareUpstreamExchange({
    translate: resolved.context.translateAnthropic,
    operation: input.operation,
    path: upstreamPath,
    body: input.request.body,
    headers: input.headers,
  });
  const entry = store.claim(
    apiProxyStreamResumeKey({
      instanceId: resolved.context.instanceId,
      path: exchange.path,
      modelId: input.target.model ?? input.request.modelId,
      body: exchange.body,
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
    exchangeBody: exchange.body,
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
  responseSink: ApiProxyResponseCaptureSink | null;
  fetchImpl?: typeof proxyUpstreamFetch;
  store?: ApiProxyPendingResumeStore;
}): Promise<Response | null> {
  const { c, request, claim, trace, recorder, inflight } = input;
  const { entry, baseUrl, authHeaders, translateAnthropic, codec } = claim;
  const fetchImpl = input.fetchImpl ?? proxyUpstreamFetch;
  const store = input.store ?? apiProxyPendingResume;

  const url = apiProxyForwardUrl(
    baseUrl,
    `/v1/stream/${entry.convId}`,
    "from=0",
  );
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
  const captureBody = (stream: ReadableStream<Uint8Array>) =>
    input.responseSink ? input.responseSink.tap(stream) : stream;
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
      trace.errorMessage = `Resumed stream replay failed: ${outcome.message}`;
      const response = input.adapter.diagnosticError(request, {
        status: 502,
        code: "llama_manager_proxy_upstream_error",
        param: "model",
        message: trace.errorMessage,
      });
      return c.json(response.body, response.status);
    }
    trace.usage = resumableTraceUsage(state);
    const final = finalFromState(effectiveCodec, state, false);
    if (typeof final.body === "string") {
      input.responseSink?.setText(final.body);
    }
    return new Response(final.body, {
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
        captureBody(upstream.body.pipeThrough(translation.transform)),
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
      captureBody(upstream.body.pipeThrough(meter.transform)),
      () => {
        store.finish(entry, { evict: true });
        meter.finalize();
      },
    ),
    { status: upstream.status, headers: upstream.headers },
  );
  return metered;
}
