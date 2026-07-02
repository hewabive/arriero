import {
  ApiProxyRequestTraceSchema,
  type ApiProxyServeRequest,
  type ApiProxyTargetRecord,
  type FleetNode,
} from "@llama-manager/core";
import type { Context } from "hono";

import { getInstance, listInstances } from "../instances/repository.js";
import { getNode } from "../nodes/repository.js";
import { observeBodyCompletion } from "./body-completion.js";
import { delegateApiProxyServe } from "./delegate.js";
import { getApiEndpointById } from "./endpoints.js";
import { externalEndpointTarget } from "./external-target.js";
import { resolvePassthroughModel } from "./passthrough.js";
import {
  buildDomainAdmissionDecider,
  parseInstanceParallelLimit,
} from "./domain-admission.js";
import {
  attachLeaseRelease,
  computeDomainCoordinator,
  type DomainLease,
} from "./domain-coordinator.js";
import { requestComputeDomains } from "./resource-domains.js";
import { apiProxyForwardUrl, forwardApiProxyRequest } from "./forwarder.js";
import {
  CLIENT_ABORT_STATUS,
  describeFetchError,
  fetchErrorCode,
} from "./http.js";
import { apiProxyInflight, type ApiProxyInflightHandle } from "./inflight.js";
import { prepareApiProxyProtocolGatewayRequest } from "./gateway.js";
import {
  buildApiProxyPlanContext,
  getApiProxyPlanPreview,
} from "./idle-maintenance.js";
import { openAiResponsesUsageCodec } from "./openai.js";
import { executeApiProxyFusion } from "./fusion.js";
import {
  resolveApiProxyRouteChain,
  type ApiProxyCacheWriteTarget,
  type ApiProxyRouteChainResult,
} from "./pipeline.js";
import {
  resolveApiProxyProtocolModelRequest,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
} from "./protocol.js";
import {
  applyServerGenerationTiming,
  createProxyTrace,
  errorBodyMessage,
  recordTraceWithDeferredTiming,
  resumableTraceUsage,
  safeJsonParse,
  type ProxyTraceAccumulator,
  type ProxyTraceRecorder,
} from "./protocol-trace.js";
import {
  getApiProxyModelByModelId,
  getApiProxyPipeline,
  getApiProxyTarget,
} from "./repository.js";
import { saveApiProxyRequestFile } from "./request-files.js";
import {
  getApiProxyCachedResponse,
  putApiProxyCachedResponse,
} from "./response-cache.js";
import {
  findApiProxyInFlight,
  registerApiProxyInFlight,
  settleApiProxyInFlight,
} from "./response-coalesce.js";
import {
  finishApiProxyBroadcast,
  pushApiProxyBroadcast,
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";
import {
  createApiProxyResponseCaptureSink,
  type ApiProxyResponseCaptureSink,
} from "./response-capture.js";
import {
  consumeResumableSse,
  createResumableBufferState,
  finalFromState,
  runResumableForward,
  runResumableUpstreamAttempt,
} from "./resumable-forward.js";
import { executeApiProxyTargetReadiness } from "./target-lifecycle.js";
import {
  resolveApiProxyUpstreamContext,
  type ApiProxyUpstreamContext,
} from "./upstream-context.js";
import { apiProxySlotTracker } from "./slot-tracker.js";
import { extractRequestApiKey, resolveApiProxySourceByKey } from "./sources.js";
import { apiProxyStats } from "./stats.js";
import {
  createAnthropicTranslationStream,
  prepareUpstreamExchange,
  translateOpenAiErrorText,
  translateOpenAiResponseText,
  translatedAnthropicResumableCodec,
} from "./translation.js";
import {
  createUsageMeterStream,
  includeUsageRequested,
  ratePerSecondFromUsage,
  requestBreaksStreamReconstruction,
  returnProgressRequested,
  usageFromNonStreamBody,
  withIncludeUsage,
  withReturnProgress,
  type ProxyUsageCounts,
} from "./usage-meter.js";

async function safeJsonBody(c: Context) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const resumableEndpoints = new Set(["chat.completions", "messages"]);

type StreamUsageMeter = {
  codec: Pick<ApiProxyResumableCodec, "parseChunk">;
  inject: boolean;
  strip: boolean;
};

type UpstreamContextResolution =
  | { ok: true; context: ApiProxyUpstreamContext }
  | { ok: false; response: Response };

function resolveStreamUsageMeter(
  operation: ApiProxyProtocolOperation,
  adapter: ApiProxyProtocolAdapter,
  body: unknown,
): StreamUsageMeter | null {
  if (adapter.resumable && resumableEndpoints.has(operation.endpoint)) {
    const isOpenAi = operation.protocol === "openai";
    return {
      codec: adapter.resumable,
      inject: isOpenAi,
      strip: isOpenAi && !includeUsageRequested(body),
    };
  }
  if (operation.protocol === "openai" && operation.endpoint === "responses") {
    return { codec: openAiResponsesUsageCodec, inject: false, strip: false };
  }
  return null;
}

async function drainApiProxyStream(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } catch {
    /* upstream error — finalize/record already records the trace and flushes */
  } finally {
    reader.releaseLock();
  }
}

export async function runWithProxyTrace(
  operation: ApiProxyProtocolOperation,
  run: (ctx: {
    trace: ProxyTraceAccumulator;
    recorder: ProxyTraceRecorder;
    inflight: ApiProxyInflightHandle;
  }) => Promise<Response>,
): Promise<Response> {
  const trace = createProxyTrace(operation);
  const started = performance.now();
  const inflight = apiProxyInflight.begin({
    modelId: "",
    protocol: operation.protocol,
  });
  let recorded = false;
  let deferred = false;
  let frozenDurationMs: number | null = null;
  let beforeRecordHook: (() => void) | null = null;
  const recorder: ProxyTraceRecorder = {
    record(response) {
      if (recorded) {
        return;
      }
      beforeRecordHook?.();
      recorded = true;
      trace.durationMs =
        frozenDurationMs ?? Math.round(performance.now() - started);
      trace.status = response?.status ?? 0;
      trace.ok = response ? response.status < 400 : false;
      inflight.end(trace.ok);
      apiProxyStats.record(ApiProxyRequestTraceSchema.parse(trace));
    },
    markDeferred() {
      deferred = true;
    },
    freezeDuration() {
      frozenDurationMs ??= Math.round(performance.now() - started);
    },
    beforeRecord(hook) {
      beforeRecordHook = hook;
    },
  };
  let response: Response | undefined;
  try {
    response = await run({ trace, recorder, inflight });
    return response;
  } catch (error) {
    if (!trace.errorMessage) {
      trace.errorMessage = describeFetchError(error);
    }
    throw error;
  } finally {
    if (!deferred) {
      recorder.record(response);
    }
  }
}

export async function proxyProtocolEndpoint(
  c: Context,
  adapter: ApiProxyProtocolAdapter,
  operation: ApiProxyProtocolOperation,
) {
  return runWithProxyTrace(operation, ({ trace, recorder, inflight }) => {
    const source = resolveApiProxySourceByKey(
      extractRequestApiKey(c.req.raw.headers),
    );
    if (source) {
      trace.sourceId = source.id;
      trace.sourceName = source.name;
    }
    return proxyProtocolEndpointInner(
      c,
      adapter,
      operation,
      trace,
      recorder,
      inflight,
    );
  });
}

async function proxyProtocolEndpointInner(
  c: Context,
  adapter: ApiProxyProtocolAdapter,
  operation: ApiProxyProtocolOperation,
  trace: ProxyTraceAccumulator,
  recorder: ProxyTraceRecorder,
  inflight: ApiProxyInflightHandle,
): Promise<Response> {
  const body = await safeJsonBody(c);
  if (body && typeof body === "object" && "model" in body) {
    const model = (body as { model?: unknown }).model;
    if (typeof model === "string") {
      trace.modelId = model;
    }
  }
  const resolution = resolveApiProxyProtocolModelRequest({
    adapter,
    operation,
    body,
    getModelByModelId: (modelId) =>
      getApiProxyModelByModelId(modelId) ?? resolvePassthroughModel(modelId),
  });

  if (!resolution.ok) {
    trace.errorMessage = errorBodyMessage(resolution.response.body);
    return c.json(resolution.response.body, resolution.response.status);
  }
  trace.modelId = resolution.request.modelId;
  inflight.setModel(resolution.request.modelId);

  if (!resolution.request.model.enabled) {
    const message = `Model ${resolution.request.modelId} is disabled`;
    trace.errorMessage = message;
    const response = adapter.diagnosticError(resolution.request, {
      status: 503,
      code: "llama_manager_proxy_model_disabled",
      param: "model",
      message,
    });
    return c.json(response.body, response.status);
  }

  const routeResult = await resolveApiProxyRouteChain({
    request: resolution.request,
    getPipeline: getApiProxyPipeline,
    sourceId: trace.sourceId,
    lookupCache: getApiProxyCachedResponse,
    findInFlight: findApiProxyInFlight,
    registerOwner: registerApiProxyInFlight,
    findBroadcast: subscribeApiProxyBroadcast,
    registerBroadcast: registerApiProxyBroadcast,
    recordRequest: (request) => {
      trace.files.push(
        saveApiProxyRequestFile({
          traceId: trace.id,
          traceAt: trace.at,
          kind: request.kind,
          label: request.nodeName,
          protocol: request.protocol,
          endpoint: request.endpoint,
          routePath: request.routePath,
          modelId: request.modelId,
          data: request.requestBody,
        }),
      );
    },
  });
  trace.routeTrace = routeResult.routeTrace;
  if (!routeResult.ok) {
    trace.errorMessage = routeResult.diagnostic.message;
    const response = adapter.diagnosticError(
      resolution.request,
      routeResult.diagnostic,
    );
    return c.json(response.body, response.status);
  }

  if (routeResult.kind === "response") {
    for (const write of routeResult.cacheWrites) {
      settleApiProxyInFlight(write.key, null);
    }
    trace.cache = routeResult.source === "coalesced" ? "coalesced" : "hit";
    trace.stream = routeResult.request.stream;
    const responseBody = routeResult.response.body;
    if (typeof responseBody === "string") {
      const usage = usageFromNonStreamBody(operation.protocol, responseBody);
      if (usage) {
        trace.usage = {
          promptTokens: usage.promptTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          completionTokens: usage.completionTokens,
          genMs: usage.genMs,
          ratePerSecond: ratePerSecondFromUsage(usage),
          prefillMs: usage.prefillMs,
          promptPerSecond: usage.promptPerSecond,
        };
      }
    }
    return new Response(responseBody, {
      status: routeResult.response.status,
      headers: { "content-type": routeResult.response.contentType },
    });
  }

  const responseSink = createApiProxyResponseCaptureSink({
    captures: routeResult.responseCaptures,
    cacheWrites: routeResult.cacheWrites,
    putCache: putApiProxyCachedResponse,
    trace,
    operation,
  });
  if (responseSink) {
    recorder.beforeRecord(() => responseSink.flush());
  }

  if (routeResult.kind === "endpoint") {
    const upstreamModel =
      routeResult.upstreamModel ?? routeResult.request.modelId;
    const target = externalEndpointTarget({
      endpointId: routeResult.endpointId,
      upstreamModel,
      name: routeResult.request.modelId,
      now: new Date().toISOString(),
    });
    trace.targetId = target.id;
    trace.targetName = target.name;
    trace.stream = routeResult.request.stream;
    trace.textReplacementCount = routeResult.textReplacementCount;
    inflight.setTarget(target.id);
    inflight.setStream(routeResult.request.stream);
    return serveResolvedTarget({
      c,
      adapter,
      operation,
      targetId: target.id,
      request: routeResult.request,
      cacheWrites: routeResult.cacheWrites,
      trace,
      recorder,
      inflight,
      extraTarget: target,
      responseSink,
    });
  }

  let route: Extract<ApiProxyRouteChainResult, { ok: true; kind: "target" }>;
  if (routeResult.kind === "fusion") {
    const fusion = await executeApiProxyFusion({
      node: routeResult.node,
      pipeline: routeResult.pipeline,
      request: routeResult.request,
      sourceId: trace.sourceId,
      signal: c.req.raw.signal,
    });
    if (fusion.kind === "error") {
      trace.errorMessage = fusion.diagnostic.message;
      const response = adapter.diagnosticError(
        routeResult.request,
        fusion.diagnostic,
      );
      return c.json(response.body, response.status);
    }
    if (fusion.kind === "direct") {
      trace.stream = routeResult.request.stream;
      if (responseSink && typeof fusion.response.body === "string") {
        responseSink.setText(fusion.response.body);
      }
      return new Response(fusion.response.body, {
        status: fusion.response.status,
        headers: fusion.response.headers,
      });
    }
    route = {
      ok: true,
      kind: "target",
      request: fusion.request,
      targetId: fusion.targetId,
      textReplacementCount: routeResult.textReplacementCount,
      responseCaptures: routeResult.responseCaptures,
      cacheWrites: routeResult.cacheWrites,
      routeTrace: routeResult.routeTrace,
    };
  } else {
    route = routeResult;
  }
  trace.targetId = route.targetId;
  trace.stream = route.request.stream;
  trace.textReplacementCount = route.textReplacementCount;
  inflight.setTarget(route.targetId);
  inflight.setStream(route.request.stream);

  const dispatchTarget = getApiProxyTarget(route.targetId);
  if (dispatchTarget) {
    const endpoint = getApiEndpointById(
      dispatchTarget.endpointId,
      listInstances(),
    );
    if (endpoint?.nodeId && endpoint.instanceId) {
      trace.targetName = dispatchTarget.name;
      const node = getNode(endpoint.nodeId);
      if (!node || !node.enabled) {
        const message = `Proxy target ${dispatchTarget.name} points at ${
          node ? "disabled" : "unknown"
        } node ${endpoint.nodeId}`;
        trace.errorMessage = message;
        const response = adapter.diagnosticError(route.request, {
          status: 503,
          code: "llama_manager_proxy_upstream_unavailable",
          param: "model",
          message,
        });
        return c.json(response.body, response.status);
      }
      return delegateRemoteTarget({
        c,
        adapter,
        operation,
        request: route.request,
        target: dispatchTarget,
        node,
        instanceId: endpoint.instanceId,
        trace,
        recorder,
        inflight,
        responseSink,
      });
    }
  }

  return serveResolvedTarget({
    c,
    adapter,
    operation,
    targetId: route.targetId,
    request: route.request,
    cacheWrites: route.cacheWrites,
    trace,
    recorder,
    inflight,
    responseSink,
  });
}

export function delegateServeRequestBody(
  request: ApiProxyProtocolModelRequest,
  operation: ApiProxyProtocolOperation,
  adapter: ApiProxyProtocolAdapter,
): unknown {
  if (!request.stream) {
    return request.body;
  }
  const streamMeter = resolveStreamUsageMeter(operation, adapter, request.body);
  let body = request.body;
  if (streamMeter?.inject) {
    body = withIncludeUsage(body);
  }
  const wantsPrefill =
    operation.endpoint === "chat.completions" ||
    operation.endpoint === "messages";
  if (wantsPrefill && !returnProgressRequested(body)) {
    body = withReturnProgress(body);
  }
  return body;
}

async function delegateRemoteTarget(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  operation: ApiProxyProtocolOperation;
  request: ApiProxyProtocolModelRequest;
  target: ApiProxyTargetRecord;
  node: FleetNode;
  instanceId: string;
  trace: ProxyTraceAccumulator;
  recorder: ProxyTraceRecorder;
  inflight: ApiProxyInflightHandle;
  responseSink?: ApiProxyResponseCaptureSink | null | undefined;
}): Promise<Response> {
  const { c, adapter, operation, request, target, node, trace, recorder } =
    input;
  const inflight = input.inflight;
  const responseSink = input.responseSink ?? null;
  const captureBody = (stream: ReadableStream<Uint8Array>) =>
    responseSink ? responseSink.tap(stream) : stream;

  const wantsPrefill =
    request.stream &&
    (operation.endpoint === "chat.completions" ||
      operation.endpoint === "messages");
  const streamMeter = request.stream
    ? resolveStreamUsageMeter(operation, adapter, request.body)
    : null;
  const serveBody = delegateServeRequestBody(request, operation, adapter);

  const payload: ApiProxyServeRequest = {
    instanceId: input.instanceId,
    protocol: operation.protocol,
    endpoint: operation.endpoint,
    stream: request.stream,
    model: target.model,
    role: target.role,
    priority: target.priority,
    preemptible: target.preemptible,
    saveSlotsBeforeUnload: target.saveSlotsBeforeUnload,
    slotIds: target.slotIds,
    body: serveBody,
  };

  let dispatchedAt: number | null = null;
  const markFirstToken = (promptTokens: number | null) => {
    if (trace.ttftMs === null && dispatchedAt !== null) {
      trace.ttftMs = Math.round(performance.now() - dispatchedAt);
    }
    inflight.firstToken(promptTokens);
  };
  const stripProgressFrames =
    wantsPrefill && !returnProgressRequested(request.body);

  try {
    dispatchedAt = performance.now();
    inflight.dispatched();
    const { upstream, headers } = await delegateApiProxyServe({
      node,
      payload,
      signal: c.req.raw.signal,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (text) {
        trace.errorMessage =
          errorBodyMessage(safeJsonParse(text)) ?? text.slice(0, 500);
      }
      return new Response(text, { status: upstream.status, headers });
    }
    if (!upstream.body) {
      return new Response(null, { status: upstream.status, headers });
    }

    if (!request.stream) {
      const text = await upstream.text();
      const usage = usageFromNonStreamBody(operation.protocol, text);
      if (usage) {
        trace.usage = {
          promptTokens: usage.promptTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          completionTokens: usage.completionTokens,
          genMs: usage.genMs,
          ratePerSecond: ratePerSecondFromUsage(usage),
          prefillMs: usage.prefillMs,
          promptPerSecond: usage.promptPerSecond,
        };
      }
      responseSink?.setText(text);
      return new Response(text, { status: upstream.status, headers });
    }

    if (!streamMeter) {
      recorder.markDeferred();
      return new Response(
        observeBodyCompletion(captureBody(upstream.body), () =>
          recorder.record(upstream),
        ),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        },
      );
    }

    let metered: Response | undefined;
    const meter = createUsageMeterStream({
      codec: streamMeter.codec,
      stripUsageFrames: streamMeter.strip,
      stripProgressFrames,
      onFirstToken: markFirstToken,
      onReasoning: () => inflight.firstReasoning(),
      onReasoningDelta: (text) => inflight.appendReasoning(text),
      onAnswerDelta: (text) => inflight.appendAnswer(text),
      onProgress: (completionTokens) =>
        inflight.setCompletionTokens(completionTokens),
      onPrefillProgress: (progress) => inflight.setPrefillProgress(progress),
      onComplete: (usage) => {
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
        recorder.record(metered);
      },
    });
    recorder.markDeferred();
    metered = new Response(
      observeBodyCompletion(
        captureBody(upstream.body.pipeThrough(meter.transform)),
        () => meter.finalize(),
      ),
      { status: upstream.status, headers },
    );
    return metered;
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      trace.errorCode = "client-abort";
      trace.errorMessage = `Client closed the request before node ${node.name} responded`;
      return new Response(null, { status: CLIENT_ABORT_STATUS });
    }
    const diagnostic = delegationErrorDiagnostic(target, node, error);
    trace.errorMessage = diagnostic.message;
    const response = adapter.diagnosticError(request, diagnostic);
    return c.json(response.body, response.status);
  }
}

const DELEGATION_TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const DELEGATION_UNREACHABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export function delegationErrorDiagnostic(
  target: ApiProxyTargetRecord,
  node: FleetNode,
  error: unknown,
): ApiProxyProtocolDiagnostic {
  const code = fetchErrorCode(error);
  if (code && DELEGATION_TIMEOUT_CODES.has(code)) {
    return {
      status: 504,
      code: "llama_manager_proxy_upstream_timeout",
      param: "model",
      message: `Proxy target ${target.name}: node ${node.name} did not respond in time (still preparing the model or stalled).`,
    };
  }
  if (code && DELEGATION_UNREACHABLE_CODES.has(code)) {
    return {
      status: 503,
      code: "llama_manager_proxy_upstream_unavailable",
      param: "model",
      message: `Proxy target ${target.name}: node ${node.name} is unreachable (${describeFetchError(error)}).`,
    };
  }
  return {
    status: 502,
    code: "llama_manager_proxy_upstream_error",
    param: "model",
    message: `Proxy target ${target.name} failed to delegate to node ${node.name}: ${describeFetchError(error)}`,
  };
}

export async function serveResolvedTarget(input: {
  c: Context;
  adapter: ApiProxyProtocolAdapter;
  operation: ApiProxyProtocolOperation;
  targetId: string;
  request: ApiProxyProtocolModelRequest;
  cacheWrites?: ApiProxyCacheWriteTarget[] | undefined;
  trace: ProxyTraceAccumulator;
  recorder: ProxyTraceRecorder;
  inflight: ApiProxyInflightHandle;
  extraTarget?: ApiProxyTargetRecord | undefined;
  responseSink?: ApiProxyResponseCaptureSink | null | undefined;
}): Promise<Response> {
  const { c, adapter, operation, trace, recorder, inflight } = input;
  const extraTarget = input.extraTarget ?? null;
  const responseSink = input.responseSink ?? null;
  const captureBody = (stream: ReadableStream<Uint8Array>) =>
    responseSink ? responseSink.tap(stream) : stream;
  const route = {
    targetId: input.targetId,
    request: input.request,
    cacheWrites: input.cacheWrites ?? [],
  };
  const getTarget = (id: string) =>
    extraTarget && id === extraTarget.id ? extraTarget : getApiProxyTarget(id);
  const planPreviewFor = (targetId: string) =>
    getApiProxyPlanPreview({
      mode: "request",
      requestedTargetId: targetId,
      ...(extraTarget ? { extraTarget } : {}),
    });

  const planContext = await buildApiProxyPlanContext({
    mode: "request",
    requestedTargetId: route.targetId,
    residency: "cached",
    ...(extraTarget ? { extraTarget } : {}),
  });

  const decision = await prepareApiProxyProtocolGatewayRequest({
    adapter,
    request: route.request,
    getTarget,
    getPlanPreview: () => Promise.resolve(planContext.preview),
    allowReadinessActions: true,
    targetIdOverride: route.targetId,
  });
  if (!decision.ok) {
    trace.errorMessage = errorBodyMessage(decision.response.body);
    return c.json(decision.response.body, decision.response.status);
  }
  trace.targetId = decision.target.id;
  trace.targetName = decision.target.name;
  trace.schedulerActions = decision.preview.plan.actions.map(
    (action) => action.type,
  );
  trace.displacedTargetIds = [
    ...new Set(
      decision.preview.plan.actions
        .filter(
          (action) =>
            (action.type === "unload-model" ||
              action.type === "stop-instance") &&
            action.targetId !== decision.target.id,
        )
        .map((action) => action.targetId),
    ),
  ];
  inflight.setTarget(decision.target.id);

  const queueStart = performance.now();
  const markQueueResolved = () => {
    if (trace.queueMs === null) {
      trace.queueMs = Math.round(performance.now() - queueStart);
    }
  };
  const planRequest = planContext.request;
  const candidatePlanTarget = planRequest.targets.find(
    (item) => item.id === decision.target.id,
  );
  const domains = requestComputeDomains(
    candidatePlanTarget?.draws ?? [],
    planRequest.pools,
  );
  const candidateInstanceId = candidatePlanTarget?.instanceId ?? null;
  const parallelLimit = candidateInstanceId
    ? parseInstanceParallelLimit(getInstance(candidateInstanceId)?.args ?? {})
    : undefined;
  let lease: DomainLease | null = null;
  if (domains.length > 0) {
    try {
      lease = await computeDomainCoordinator.acquire({
        domains,
        targetId: decision.target.id,
        priority: decision.target.priority,
        preemptible: decision.target.preemptible,
        signal: c.req.raw.signal,
        decide: buildDomainAdmissionDecider({
          candidateTargetId: decision.target.id,
          candidatePriority: decision.target.priority,
          planRequest,
          ...(parallelLimit !== undefined ? { parallelLimit } : {}),
        }),
      });
    } catch {
      const message = `Request for model ${route.request.modelId} was aborted while queued.`;
      trace.errorMessage = message;
      const response = adapter.diagnosticError(route.request, {
        status: 503,
        code: "llama_manager_proxy_upstream_unavailable",
        param: "model",
        message,
      });
      return c.json(response.body, response.status);
    }
  }
  markQueueResolved();

  let dispatchedAt: number | null = null;
  const markDispatched = () => {
    if (dispatchedAt === null) {
      dispatchedAt = performance.now();
    }
    inflight.dispatched();
  };
  const markFirstToken = (promptTokens: number | null) => {
    if (trace.ttftMs === null && dispatchedAt !== null) {
      trace.ttftMs = Math.round(performance.now() - dispatchedAt);
    }
    inflight.firstToken(promptTokens);
  };
  const markReasoning = () => {
    inflight.firstReasoning();
  };
  const markReasoningDelta = (text: string) => {
    inflight.appendReasoning(text);
  };
  const markAnswerDelta = (text: string) => {
    inflight.appendAnswer(text);
  };
  const markToolCall = (delta: {
    index: number;
    id?: string | undefined;
    name?: string | undefined;
    arguments?: string | undefined;
  }) => {
    inflight.appendToolCall(delta);
  };
  const markProgress = (completionTokens: number) => {
    inflight.setCompletionTokens(completionTokens);
  };
  const markPrefillProgress = (progress: {
    total: number;
    processed: number;
    cache: number;
  }) => {
    inflight.setPrefillProgress(progress);
  };

  const makeTargetReady = (
    initialPreview: Awaited<ReturnType<typeof getApiProxyPlanPreview>>,
  ) =>
    executeApiProxyTargetReadiness(
      decision.target,
      initialPreview,
      domains,
      extraTarget ?? undefined,
      c.req.raw.signal,
    );

  const freshRequestPreview = () => planPreviewFor(decision.target.id);

  const resolveUpstreamContext = (): UpstreamContextResolution => {
    const resolved = resolveApiProxyUpstreamContext({
      target: decision.target,
      operation,
    });
    if (!resolved.ok) {
      trace.errorMessage = resolved.diagnostic.message;
      const response = adapter.diagnosticError(
        route.request,
        resolved.diagnostic,
      );
      return { ok: false, response: c.json(response.body, response.status) };
    }
    trace.translated = resolved.context.translateAnthropic;
    return { ok: true, context: resolved.context };
  };

  const markClientAbort = () => {
    trace.errorCode = "client-abort";
    trace.errorMessage = `Client closed the request before target ${decision.target.name} finished responding`;
  };

  const respond = async (): Promise<Response> => {
    const stopSignal = AbortSignal.any([
      c.req.raw.signal,
      inflight.finishSignal(),
      inflight.cancelSignal(),
    ]);
    const upstreamPath = adapter.upstreamPath(operation);
    if (!upstreamPath) {
      const response = adapter.notImplemented(route.request);
      return c.json(response.body, response.status);
    }

    const execution = await makeTargetReady(decision.preview);
    if (!execution.ok) {
      trace.errorMessage = execution.diagnostic.message;
      const response = adapter.diagnosticError(
        route.request,
        execution.diagnostic,
      );
      return c.json(response.body, response.status);
    }

    const resolved = resolveUpstreamContext();
    if (!resolved.ok) {
      return resolved.response;
    }
    const { baseUrl, instanceId, authHeaders, translateAnthropic } =
      resolved.context;
    const exchange = prepareUpstreamExchange({
      translate: translateAnthropic,
      operation,
      path: upstreamPath,
      body: route.request.body,
      headers: c.req.raw.headers,
    });

    const streamMeter: StreamUsageMeter | null =
      route.request.stream && !translateAnthropic
        ? resolveStreamUsageMeter(operation, adapter, route.request.body)
        : null;
    const bufferCodec: ApiProxyResumableCodec | null =
      !route.request.stream &&
      instanceId !== null &&
      !translateAnthropic &&
      adapter.resumable &&
      resumableEndpoints.has(operation.endpoint) &&
      !requestBreaksStreamReconstruction(route.request.body)
        ? adapter.resumable
        : null;
    const injectUsage = translateAnthropic
      ? route.request.stream
      : (streamMeter?.inject ?? false);
    const wantsPrefillProgress =
      instanceId !== null &&
      (translateAnthropic
        ? route.request.stream
        : streamMeter !== null && operation.endpoint === "chat.completions");
    const injectPrefillProgress =
      wantsPrefillProgress && !returnProgressRequested(exchange.body);
    let forwardBody: unknown;
    if (bufferCodec) {
      const built = bufferCodec.upstreamBody(exchange.body, null);
      forwardBody = returnProgressRequested(exchange.body)
        ? built
        : withReturnProgress(built);
    } else {
      forwardBody = injectUsage
        ? withIncludeUsage(exchange.body)
        : exchange.body;
      if (injectPrefillProgress) {
        forwardBody = withReturnProgress(forwardBody);
      }
    }

    const slotSeq =
      instanceId !== null ? apiProxySlotTracker.mark(instanceId) : null;
    const resolveSlot = (): number | null => {
      if (instanceId !== null && slotSeq !== null) {
        const resolved = apiProxySlotTracker.resolve(instanceId, slotSeq);
        trace.slotId = resolved.slotId;
        trace.cacheOrigin = resolved.origin;
        return resolved.task;
      }
      return null;
    };

    try {
      markDispatched();
      const upstream = await forwardApiProxyRequest({
        baseUrl,
        method: c.req.method,
        upstreamPath: exchange.path,
        search: new URL(c.req.url).search,
        headers: exchange.headers,
        body: forwardBody,
        upstreamHeaders: authHeaders,
        modelOverride: decision.target.model,
        signal: stopSignal,
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        if (text) {
          trace.errorMessage =
            errorBodyMessage(safeJsonParse(text)) ?? text.slice(0, 500);
        }
        if (translateAnthropic) {
          return new Response(translateOpenAiErrorText(upstream.status, text), {
            status: upstream.status,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(text, {
          status: upstream.status,
          headers: upstream.headers,
        });
      }

      if (!route.request.stream) {
        if (bufferCodec && upstream.body) {
          const state = createResumableBufferState();
          const outcome = await consumeResumableSse({
            body: upstream.body,
            codec: bufferCodec,
            state,
            consumerSignal: c.req.raw.signal,
            finishSignal: inflight.finishSignal(),
            cancelSignal: inflight.cancelSignal(),
            onFirstToken: markFirstToken,
            onReasoning: markReasoning,
            onReasoningDelta: markReasoningDelta,
            onAnswerDelta: markAnswerDelta,
            onToolCall: markToolCall,
            onProgress: markProgress,
            onPrefillProgress: markPrefillProgress,
          });
          if (
            outcome.type === "consumer-gone" ||
            outcome.type === "cancelled"
          ) {
            markClientAbort();
            return new Response(null, { status: CLIENT_ABORT_STATUS });
          }
          if (outcome.type === "error") {
            const message = `Proxy target ${decision.target.name} failed to forward request: ${outcome.message}`;
            trace.errorMessage = message;
            const response = adapter.diagnosticError(route.request, {
              status: 502,
              code: "llama_manager_proxy_upstream_error",
              param: "model",
              message,
            });
            return c.json(response.body, response.status);
          }
          trace.usage = resumableTraceUsage(state);
          const task = resolveSlot();
          const final = finalFromState(bufferCodec, state, false);
          if (typeof final.body === "string") {
            responseSink?.setText(final.body);
          }
          return recordTraceWithDeferredTiming({
            recorder,
            trace,
            instanceId,
            task,
            response: new Response(final.body, {
              status: final.status,
              headers: final.headers,
            }),
          });
        }
        const text = await upstream.text();
        const usage = usageFromNonStreamBody(exchange.protocol, text);
        if (usage) {
          trace.usage = {
            promptTokens: usage.promptTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            completionTokens: usage.completionTokens,
            genMs: usage.genMs,
            ratePerSecond: ratePerSecondFromUsage(usage),
            prefillMs: usage.prefillMs,
            promptPerSecond: usage.promptPerSecond,
          };
        }
        const task = resolveSlot();
        const translatedText = translateAnthropic
          ? translateOpenAiResponseText(text)
          : null;
        responseSink?.setText(translatedText ?? text);
        const nonStreamResponse =
          translatedText !== null
            ? new Response(translatedText, {
                status: upstream.status,
                headers: { "content-type": "application/json" },
              })
            : new Response(text, {
                status: upstream.status,
                headers: upstream.headers,
              });
        return recordTraceWithDeferredTiming({
          recorder,
          trace,
          instanceId,
          task,
          response: nonStreamResponse,
        });
      }

      const streamOwnerKey =
        route.cacheWrites.length > 0
          ? (route.cacheWrites[0]?.key ?? null)
          : null;
      const finishStreamResponse = (
        observed: ReadableStream<Uint8Array>,
        status: number,
        headers: Headers,
        statusText?: string,
      ): Response => {
        const responseInit: ResponseInit = statusText
          ? { status, headers, statusText }
          : { status, headers };
        if (streamOwnerKey) {
          const subscription = subscribeApiProxyBroadcast(streamOwnerKey);
          if (subscription) {
            void drainApiProxyStream(observed);
            return new Response(subscription.body, responseInit);
          }
        }
        return new Response(observed, responseInit);
      };

      let metered: Response | undefined;
      const onStreamComplete = (usage: ProxyUsageCounts) => {
        recorder.freezeDuration();
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
        const task = resolveSlot();
        void applyServerGenerationTiming(trace, instanceId, task).finally(() =>
          recorder.record(metered),
        );
      };

      if (translateAnthropic) {
        const translation = createAnthropicTranslationStream({
          onFirstToken: markFirstToken,
          onReasoning: markReasoning,
          onReasoningDelta: markReasoningDelta,
          onAnswerDelta: markAnswerDelta,
          onProgress: markProgress,
          onPrefillProgress: markPrefillProgress,
          onComplete: onStreamComplete,
        });
        recorder.markDeferred();
        metered = finishStreamResponse(
          observeBodyCompletion(
            captureBody(upstream.body.pipeThrough(translation.transform)),
            () => translation.finalize(),
          ),
          upstream.status,
          upstream.headers,
        );
        return metered;
      }

      if (!streamMeter) {
        recorder.markDeferred();
        return finishStreamResponse(
          observeBodyCompletion(captureBody(upstream.body), () =>
            recorder.record(upstream),
          ),
          upstream.status,
          upstream.headers,
          upstream.statusText,
        );
      }

      const meter = createUsageMeterStream({
        codec: streamMeter.codec,
        stripUsageFrames: streamMeter.strip,
        stripProgressFrames: injectPrefillProgress,
        onFirstToken: markFirstToken,
        onReasoning: markReasoning,
        onReasoningDelta: markReasoningDelta,
        onAnswerDelta: markAnswerDelta,
        onToolCall: markToolCall,
        onProgress: markProgress,
        onPrefillProgress: markPrefillProgress,
        onComplete: onStreamComplete,
      });
      recorder.markDeferred();
      metered = finishStreamResponse(
        observeBodyCompletion(
          captureBody(upstream.body.pipeThrough(meter.transform)),
          () => meter.finalize(),
        ),
        upstream.status,
        upstream.headers,
      );
      return metered;
    } catch (error) {
      if (c.req.raw.signal.aborted) {
        markClientAbort();
        return new Response(null, { status: CLIENT_ABORT_STATUS });
      }
      const message = `Proxy target ${decision.target.name} failed to forward request: ${describeFetchError(error)}`;
      trace.errorMessage = message;
      const response = adapter.diagnosticError(route.request, {
        status: 502,
        code: "llama_manager_proxy_upstream_error",
        param: "model",
        message,
      });
      return c.json(response.body, response.status);
    }
  };

  const respondResumable = async (
    heldLease: DomainLease,
    upstreamPath: string,
    codec: NonNullable<typeof adapter.resumable>,
  ): Promise<Response> => {
    const resolved = resolveUpstreamContext();
    if (!resolved.ok) {
      return resolved.response;
    }
    const { baseUrl, instanceId, authHeaders, translateAnthropic } =
      resolved.context;
    const exchange = prepareUpstreamExchange({
      translate: translateAnthropic,
      operation,
      path: upstreamPath,
      body: route.request.body,
      headers: c.req.raw.headers,
    });
    const effectiveCodec = translateAnthropic
      ? translatedAnthropicResumableCodec(exchange.body)
      : codec;
    const url = apiProxyForwardUrl(
      baseUrl,
      exchange.path,
      new URL(c.req.url).search,
    );
    const slotSeq =
      instanceId !== null ? apiProxySlotTracker.mark(instanceId) : null;
    const injectPrefillProgress =
      (operation.protocol === "openai" || translateAnthropic) &&
      instanceId !== null &&
      !returnProgressRequested(route.request.body);
    const forceAnswerSupported =
      instanceId !== null &&
      (operation.protocol === "openai" || translateAnthropic);
    inflight.setInterruptible(forceAnswerSupported);
    const buildForceAnswerTail = forceAnswerSupported
      ? (reasoningText: string): string | null => {
          const trimmed = reasoningText.trimEnd();
          return `<think>\n${trimmed}\n</think>\n\n`;
        }
      : undefined;
    const state = createResumableBufferState();
    const buildBody = (tail: string | null) => {
      const built = effectiveCodec.upstreamBody(
        route.request.body,
        tail,
      ) as Record<string, unknown>;
      const withModel = decision.target.model
        ? { ...built, model: decision.target.model }
        : built;
      return injectPrefillProgress
        ? { ...withModel, return_progress: true }
        : withModel;
    };

    let readyFromPlanContext = true;
    const final = await runResumableForward({
      makeReady: async () => {
        const initialPreview = readyFromPlanContext
          ? planContext.preview
          : await freshRequestPreview();
        readyFromPlanContext = false;
        const execution = await makeTargetReady(initialPreview);
        if (execution.ok) {
          return { ok: true };
        }
        trace.errorMessage = execution.diagnostic.message;
        const response = adapter.diagnosticError(
          route.request,
          execution.diagnostic,
        );
        return {
          ok: false,
          final: {
            status: response.status,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(response.body),
          },
        };
      },
      attempt: (tail) => {
        markDispatched();
        return runResumableUpstreamAttempt({
          url,
          method: c.req.method,
          headers: authHeaders,
          body: buildBody(tail),
          codec: effectiveCodec,
          state,
          preemptSignal: heldLease.preemptSignal,
          consumerSignal: c.req.raw.signal,
          interruptSignal: inflight.interruptSignal(),
          finishSignal: inflight.finishSignal(),
          cancelSignal: inflight.cancelSignal(),
          onFirstToken: markFirstToken,
          onReasoning: markReasoning,
          onReasoningDelta: markReasoningDelta,
          onAnswerDelta: markAnswerDelta,
          onToolCall: markToolCall,
          onProgress: markProgress,
          onPrefillProgress: markPrefillProgress,
        });
      },
      state,
      codec: effectiveCodec,
      yieldLease: () => heldLease.yield(),
      wantsStream: route.request.stream,
      ...(buildForceAnswerTail ? { buildForceAnswerTail } : {}),
      onError: (message) => {
        trace.errorMessage = `Proxy target ${decision.target.name} failed to forward request: ${message}`;
        const response = adapter.diagnosticError(route.request, {
          status: 502,
          code: "llama_manager_proxy_upstream_error",
          param: "model",
          message: `Proxy target ${decision.target.name} failed to forward request: ${message}`,
        });
        return {
          status: response.status,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(response.body),
        };
      },
    });

    trace.usage = resumableTraceUsage(state);
    let task: number | null = null;
    if (instanceId !== null && slotSeq !== null) {
      const resolved = apiProxySlotTracker.resolve(instanceId, slotSeq);
      trace.slotId = resolved.slotId;
      trace.cacheOrigin = resolved.origin;
      task = resolved.task;
    }

    const streamWrite =
      route.request.stream && route.cacheWrites.length > 0
        ? (route.cacheWrites[0] ?? null)
        : null;
    if (final.status === CLIENT_ABORT_STATUS) {
      markClientAbort();
      if (streamWrite) {
        finishApiProxyBroadcast(streamWrite.key);
      }
    } else if (streamWrite) {
      if (typeof final.body === "string" && !trace.errorMessage) {
        putApiProxyCachedResponse({
          key: streamWrite.key,
          modelId: trace.modelId,
          status: 200,
          contentType: "text/event-stream",
          isSse: true,
          body: final.body,
          ttlSeconds: streamWrite.ttlSeconds,
        });
        trace.cache = "store";
        pushApiProxyBroadcast(
          streamWrite.key,
          new TextEncoder().encode(final.body),
        );
      }
      finishApiProxyBroadcast(streamWrite.key);
    } else if (responseSink) {
      const captured = finalFromState(effectiveCodec, state, false);
      if (typeof captured.body === "string") {
        responseSink.setText(captured.body);
      }
    }
    return recordTraceWithDeferredTiming({
      recorder,
      trace,
      instanceId,
      task,
      response: new Response(final.body, {
        status: final.status,
        headers: final.headers,
      }),
    });
  };

  if (!lease) {
    return respond();
  }

  const heldLease = lease;
  const resumableUpstreamPath = adapter.upstreamPath(operation);
  if (
    decision.target.preemptible &&
    adapter.resumable &&
    resumableEndpoints.has(operation.endpoint) &&
    resumableUpstreamPath
  ) {
    const codec = adapter.resumable;
    try {
      return await respondResumable(heldLease, resumableUpstreamPath, codec);
    } finally {
      heldLease.release();
    }
  }

  try {
    return attachLeaseRelease(await respond(), heldLease);
  } catch (error) {
    heldLease.release();
    throw error;
  }
}
