import {
  type ApiProxyServeRequest,
  type ApiProxyTargetRecord,
  type FleetNode,
} from "@arriero/core";
import type { Context } from "hono";

import { getInstance, listInstances } from "../instances/repository.js";
import { getNode } from "../nodes/repository.js";
import { observeBodyCompletion } from "./body-completion.js";
import { apiProxyDrainBody, isApiProxyDraining } from "./drain.js";
import { delegateApiProxyServe } from "./delegate.js";
import {
  delegatedTraceHeader,
  recordDelegatedTrace,
} from "./delegated-trace.js";
import { getApiEndpointById } from "./endpoints.js";
import { externalEndpointTarget } from "./external-target.js";
import { resolvePassthroughModel } from "./passthrough.js";
import {
  buildDomainAdmissionDecider,
  parseInstanceConcurrencyLimit,
} from "./domain-admission.js";
import {
  attachLeaseRelease,
  computeDomainCoordinator,
  type DomainLease,
} from "./domain-coordinator.js";
import { requestComputeDomains } from "./resource-domains.js";
import { buildThinkForceAnswerTail } from "./force-answer.js";
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
  apiProxyCacheStores,
  resolveApiProxyRouteChain,
  type ApiProxyPipelineRecordRequestInput,
  type ApiProxyResponseEffect,
  type ApiProxyRouteChainResult,
} from "./pipeline.js";
import {
  apiProxyOperationSpec,
  resolveApiProxyProtocolModelRequest,
  type ApiProxyOperationBodyMode,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
} from "./protocol.js";
import {
  applyServerGenerationTiming,
  applyTraceDiagnostic,
  createProxyTrace,
  errorBodyMessage,
  markTraceClientAbort,
  recordTraceWithDeferredTiming,
  resumableTraceUsage,
  traceDiagnosticResponse,
  traceUsageFromCounts,
  truncatedStreamResponse,
  upstreamErrorText,
  type ProxyTraceAccumulator,
  type ProxyTraceRecorder,
} from "./protocol-trace.js";
import {
  getApiProxyModelByModelId,
  getApiProxyPipeline,
  getApiProxyTarget,
} from "./repository.js";
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
import { saveApiProxyRequestFile } from "./request-files.js";
import {
  getApiProxyCachedResponse,
  putApiProxyCachedResponse,
} from "./response-cache.js";
import {
  findApiProxyInFlight,
  registerApiProxyInFlight,
} from "./response-coalesce.js";
import {
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";
import {
  applyApiProxyResponsePlanText,
  createApiProxyResponsePlanExecutor,
  tapApiProxyResponsePlanStream,
  type ApiProxyResponsePlanExecutor,
} from "./response-plan.js";
import {
  claimApiProxyResumedSession,
  serveResumedStreamSession,
} from "./resume-replay.js";
import {
  consumeResumableSse,
  createResumableBufferState,
  finalFromState,
  runResumableForward,
  runResumableUpstreamAttempt,
} from "./resumable-forward.js";
import {
  applyProxyStreamHealth,
  markPlanTruncatedOnEof,
} from "./stream-health.js";
import { watchStreamIdle } from "./stream-idle.js";
import { inflightStreamObserver } from "./stream-observer.js";
import { executeApiProxyTargetReadiness } from "./target-lifecycle.js";
import {
  proxyEngineGates,
  requestLeasePreemptible,
} from "./engine-capabilities.js";
import {
  resolveApiProxyUpstreamContext,
  type ApiProxyUpstreamContext,
} from "./upstream-context.js";
import { apiProxySlotTracker } from "./slot-tracker.js";
import { apiProxyRequestGate } from "./sources.js";
import { apiProxyStats } from "./stats.js";
import {
  apiProxyStreamResumeKey,
  apiProxyStreamSessions,
} from "./stream-session.js";
import {
  createAnthropicTranslationStream,
  translateOpenAiErrorText,
  translateOpenAiResponseText,
  translatedAnthropicResumableCodec,
} from "./translation.js";
import {
  createUsageMeterStream,
  includeUsageRequested,
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

const operationBodyReaders: Record<
  ApiProxyOperationBodyMode,
  (c: Context) => Promise<unknown>
> = {
  json: safeJsonBody,
};

function readOperationBody(
  c: Context,
  operation: ApiProxyProtocolOperation,
): Promise<unknown> {
  const bodyMode = apiProxyOperationSpec(operation)?.bodyMode ?? "json";
  return operationBodyReaders[bodyMode](c);
}

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
  const usageMeter = apiProxyOperationSpec(operation)?.usageMeter ?? null;
  if (usageMeter === "resumable" && adapter.resumable) {
    const isOpenAi = operation.protocol === "openai";
    return {
      codec: adapter.resumable,
      inject: isOpenAi,
      strip: isOpenAi && !includeUsageRequested(body),
    };
  }
  if (usageMeter === "responses") {
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
  } finally {
    reader.releaseLock();
  }
}

function decoupledStreamResponse(
  observed: ReadableStream<Uint8Array>,
  streamOwnerKey: string | null,
  init: ResponseInit,
): Response {
  if (!streamOwnerKey) {
    return new Response(observed, init);
  }
  const [client, drain] = observed.tee();
  void drainApiProxyStream(drain);
  return new Response(client, init);
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
      apiProxyStreamSessions.release(inflight.id);
      apiProxyStats.record({ ...trace });
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
  if (isApiProxyDraining()) {
    c.header("retry-after", "5");
    return c.json(apiProxyDrainBody(adapter), 503);
  }
  return runWithProxyTrace(operation, async ({ trace, recorder, inflight }) => {
    const { resolution, rejection } = apiProxyRequestGate(c.req.raw.headers);
    if (resolution.kind === "source") {
      trace.sourceId = resolution.id;
      trace.sourceName = resolution.name;
      inflight.setSource(resolution.id, resolution.name);
    }
    if (rejection) {
      applyTraceDiagnostic(trace, rejection);
      const response = adapter.authError(rejection);
      return c.json(response.body, response.status);
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
  const body = await readOperationBody(c, operation);
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
    return traceDiagnosticResponse({
      c,
      adapter,
      request: resolution.request,
      trace,
      diagnostic: {
        status: 409,
        code: "arriero_proxy_model_disabled",
        param: "model",
        errorClass: "conflict",
        retryable: false,
        message:
          resolution.request.model.blockedMessage ||
          `Model ${resolution.request.modelId} is disabled by the administrator.`,
      },
    });
  }

  const recordRouteRequest = (request: ApiProxyPipelineRecordRequestInput) => {
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
  };

  const routeResult = await resolveApiProxyRouteChain({
    request: resolution.request,
    getPipeline: getApiProxyPipeline,
    sourceId: trace.sourceId,
    lookupCache: getApiProxyCachedResponse,
    findInFlight: findApiProxyInFlight,
    registerOwner: registerApiProxyInFlight,
    findBroadcast: subscribeApiProxyBroadcast,
    registerBroadcast: registerApiProxyBroadcast,
    recordRequest: recordRouteRequest,
  });
  trace.routeTrace = routeResult.routeTrace;

  const createResponsePlan = (effects: ApiProxyResponseEffect[]) => {
    const plan = createApiProxyResponsePlanExecutor({
      effects,
      putCache: putApiProxyCachedResponse,
      trace,
      operation,
      onEarlyFinish: () => {
        apiProxyInflight.requestFinish(inflight.id);
      },
    });
    if (plan) {
      recorder.beforeRecord(() => plan.flush());
    }
    return plan;
  };

  if (!routeResult.ok) {
    createResponsePlan(routeResult.responseEffects);
    return traceDiagnosticResponse({
      c,
      adapter,
      request: resolution.request,
      trace,
      diagnostic: routeResult.diagnostic,
    });
  }

  if (routeResult.kind === "response") {
    trace.cache = routeResult.source === "coalesced" ? "coalesced" : "hit";
    trace.stream = routeResult.request.stream;
    trace.textReplacementCount = routeResult.textReplacementCount;
    const responsePlan = createResponsePlan(routeResult.responseEffects);
    const { status, contentType } = routeResult.response;
    const init: ResponseInit = {
      status,
      headers: { "content-type": contentType },
    };
    const metadata = {
      status,
      contentType,
      isSse: contentType.startsWith("text/event-stream"),
    };
    const responseBody = routeResult.response.body;
    if (typeof responseBody === "string") {
      const usage = usageFromNonStreamBody(operation.protocol, responseBody);
      if (usage) {
        trace.usage = traceUsageFromCounts(usage);
      }
      return new Response(
        applyApiProxyResponsePlanText(responsePlan, responseBody, metadata),
        init,
      );
    }
    if (responsePlan) {
      recorder.markDeferred();
      let response: Response;
      response = new Response(
        observeBodyCompletion(responsePlan.tap(responseBody, metadata), () =>
          recorder.record(response),
        ),
        init,
      );
      return response;
    }
    return new Response(responseBody, init);
  }

  if (routeResult.kind === "endpoint") {
    const upstreamModel =
      routeResult.upstreamModel ?? routeResult.request.modelId;
    const target = externalEndpointTarget({
      endpointId: routeResult.endpointId,
      upstreamModel,
      name: routeResult.request.modelId,
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
      streamOwnerKey:
        apiProxyCacheStores(routeResult.responseEffects)[0]?.key ?? null,
      trace,
      recorder,
      inflight,
      extraTarget: target,
      responsePlan: createResponsePlan(routeResult.responseEffects),
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
      io: {
        trace,
        putCache: putApiProxyCachedResponse,
        recordRequest: recordRouteRequest,
        lookupCache: getApiProxyCachedResponse,
        registerOwner: registerApiProxyInFlight,
        ownedKeys: new Set(
          apiProxyCacheStores(routeResult.responseEffects).map(
            (effect) => effect.key,
          ),
        ),
      },
    });
    const branchReplacements = fusion.branches.reduce(
      (sum, branch) => sum + branch.textReplacementCount,
      0,
    );
    trace.routeTrace = [
      ...routeResult.routeTrace,
      ...fusion.branches.flatMap((branch) => [
        {
          kind: "fusion-branch" as const,
          pipelineId: routeResult.pipeline.id,
          pipelineName: routeResult.pipeline.name,
          nodeId: routeResult.node.id,
          nodeName: routeResult.node.name || null,
          port: branch.branch,
          detail: branch.detail,
        },
        ...branch.routeTrace,
      ]),
    ];
    if (fusion.kind === "error") {
      createResponsePlan(routeResult.responseEffects);
      trace.textReplacementCount =
        routeResult.textReplacementCount + branchReplacements;
      return traceDiagnosticResponse({
        c,
        adapter,
        request: routeResult.request,
        trace,
        diagnostic: fusion.diagnostic,
      });
    }
    if (fusion.kind === "direct") {
      trace.stream = routeResult.request.stream;
      trace.textReplacementCount =
        routeResult.textReplacementCount + branchReplacements;
      const responsePlan = createResponsePlan([
        ...routeResult.responseEffects,
        ...fusion.responseEffects,
      ]);
      const contentType =
        fusion.response.headers["content-type"] ??
        (routeResult.request.stream ? "text/event-stream" : "application/json");
      const delivered = applyApiProxyResponsePlanText(
        responsePlan,
        fusion.response.body,
        {
          status: fusion.response.status,
          contentType,
          isSse: routeResult.request.stream,
        },
      );
      return new Response(delivered, {
        status: fusion.response.status,
        headers: fusion.response.headers,
      });
    }
    route = {
      ok: true,
      kind: "target",
      request: fusion.request,
      targetId: fusion.targetId,
      textReplacementCount:
        routeResult.textReplacementCount + branchReplacements,
      responseEffects: [
        ...routeResult.responseEffects,
        ...fusion.responseEffects,
      ],
      routeTrace: trace.routeTrace,
    };
  } else {
    route = routeResult;
  }
  trace.targetId = route.targetId;
  trace.stream = route.request.stream;
  trace.textReplacementCount = route.textReplacementCount;
  inflight.setTarget(route.targetId);
  inflight.setStream(route.request.stream);
  const responsePlan = createResponsePlan(route.responseEffects);

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
        return traceDiagnosticResponse({
          c,
          adapter,
          request: route.request,
          trace,
          diagnostic: {
            status: 503,
            code: "arriero_proxy_upstream_unavailable",
            param: "model",
            message: `Proxy target ${dispatchTarget.name} points at ${
              node ? "disabled" : "unknown"
            } node ${endpoint.nodeId}`,
          },
        });
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
        responsePlan,
        streamOwnerKey:
          apiProxyCacheStores(route.responseEffects)[0]?.key ?? null,
      });
    }
  }

  return serveResolvedTarget({
    c,
    adapter,
    operation,
    targetId: route.targetId,
    request: route.request,
    streamOwnerKey: apiProxyCacheStores(route.responseEffects)[0]?.key ?? null,
    trace,
    recorder,
    inflight,
    responsePlan,
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
  const spec = apiProxyOperationSpec(operation);
  const wantsPrefill =
    spec !== null && (spec.promptProgress || spec.translatesToOpenAiChat);
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
  responsePlan?: ApiProxyResponsePlanExecutor | null | undefined;
  streamOwnerKey?: string | null | undefined;
}): Promise<Response> {
  const { c, adapter, operation, request, target, node, trace, recorder } =
    input;
  const inflight = input.inflight;
  const responsePlan = input.responsePlan ?? null;
  const streamOwnerKey = input.streamOwnerKey ?? null;

  const operationSpec = apiProxyOperationSpec(operation);
  const wantsPrefill =
    request.stream &&
    operationSpec !== null &&
    (operationSpec.promptProgress || operationSpec.translatesToOpenAiChat);
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
    origin: {
      inflightId: inflight.id,
      sourceId: trace.sourceId,
      sourceName: trace.sourceName,
    },
    body: serveBody,
  };

  let dispatchedAt: number | null = null;
  const markFirstToken = (promptTokens: number | null) => {
    if (trace.ttftMs === null && dispatchedAt !== null) {
      trace.ttftMs = Math.round(performance.now() - dispatchedAt);
    }
    inflight.firstToken(promptTokens);
  };
  const observer = inflightStreamObserver(inflight, {
    onFirstToken: markFirstToken,
  });
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
    const remoteTraceId = upstream.headers.get(delegatedTraceHeader);
    headers.delete(delegatedTraceHeader);
    const recordWithDelegatedTrace = (status: number | undefined) => {
      const result = status === undefined ? undefined : { status };
      if (!remoteTraceId) {
        recorder.record(result);
        return;
      }
      recorder.freezeDuration();
      recordDelegatedTrace({
        node,
        traceId: remoteTraceId,
        trace,
        record: () => recorder.record(result),
      });
    };
    const respond = (body: BodyInit | null) => {
      recorder.markDeferred();
      const response = new Response(body, {
        status: upstream.status,
        headers,
      });
      recordWithDelegatedTrace(response.status);
      return response;
    };
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (text) {
        trace.errorMessage = upstreamErrorText(text);
      }
      return respond(text);
    }
    if (!upstream.body) {
      return respond(null);
    }

    if (!request.stream) {
      const text = await upstream.text();
      const usage = usageFromNonStreamBody(operation.protocol, text);
      if (usage) {
        trace.usage = traceUsageFromCounts(usage);
      }
      const delivered = applyApiProxyResponsePlanText(responsePlan, text, {
        status: upstream.status,
        contentType: headers.get("content-type") ?? "application/json",
        isSse: false,
      });
      return respond(delivered);
    }

    if (!streamMeter) {
      recorder.markDeferred();
      return decoupledStreamResponse(
        observeBodyCompletion(
          tapApiProxyResponsePlanStream(
            responsePlan,
            upstream.body,
            upstream.status,
            headers,
          ),
          () => recordWithDelegatedTrace(upstream.status),
        ),
        streamOwnerKey,
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
      onStreamEnd: markPlanTruncatedOnEof(responsePlan),
      ...observer,
      onComplete: (usage) => {
        trace.usage = traceUsageFromCounts(usage);
        recordWithDelegatedTrace(metered?.status);
      },
    });
    recorder.markDeferred();
    metered = decoupledStreamResponse(
      observeBodyCompletion(
        tapApiProxyResponsePlanStream(
          responsePlan,
          upstream.body.pipeThrough(meter.transform),
          upstream.status,
          headers,
        ),
        () => {
          applyProxyStreamHealth({ trace, health: meter.health() });
          meter.finalize();
        },
      ),
      streamOwnerKey,
      { status: upstream.status, headers },
    );
    return metered;
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      markTraceClientAbort(
        trace,
        `Client closed the request before node ${node.name} responded`,
      );
      return new Response(null, { status: CLIENT_ABORT_STATUS });
    }
    return traceDiagnosticResponse({
      c,
      adapter,
      request,
      trace,
      diagnostic: delegationErrorDiagnostic(target, node, error),
    });
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
      code: "arriero_proxy_upstream_timeout",
      param: "model",
      message: `Proxy target ${target.name}: node ${node.name} did not respond in time (still preparing the model or stalled).`,
    };
  }
  if (code && DELEGATION_UNREACHABLE_CODES.has(code)) {
    return {
      status: 503,
      code: "arriero_proxy_upstream_unavailable",
      param: "model",
      message: `Proxy target ${target.name}: node ${node.name} is unreachable (${describeFetchError(error)}).`,
    };
  }
  return {
    status: 502,
    code: "arriero_proxy_upstream_error",
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
  streamOwnerKey?: string | null | undefined;
  trace: ProxyTraceAccumulator;
  recorder: ProxyTraceRecorder;
  inflight: ApiProxyInflightHandle;
  extraTarget?: ApiProxyTargetRecord | undefined;
  responsePlan?: ApiProxyResponsePlanExecutor | null | undefined;
}): Promise<Response> {
  const { c, adapter, operation, trace, recorder, inflight } = input;
  const operationSpec = apiProxyOperationSpec(operation);
  const extraTarget = input.extraTarget ?? null;
  const responsePlan = input.responsePlan ?? null;
  const streamOwnerKey = input.streamOwnerKey ?? null;
  const route = {
    targetId: input.targetId,
    request: input.request,
  };
  const getTarget = (id: string) =>
    extraTarget && id === extraTarget.id ? extraTarget : getApiProxyTarget(id);
  const planPreviewFor = (targetId: string) =>
    getApiProxyPlanPreview({
      mode: "request",
      requestedTargetId: targetId,
      ...(extraTarget ? { extraTarget } : {}),
    });

  const resumeTarget = getTarget(route.targetId);
  const resumeClaim = claimApiProxyResumedSession({
    operation,
    adapter,
    request: route.request,
    target: resumeTarget,
    headers: c.req.raw.headers,
  });
  if (resumeClaim && resumeTarget) {
    trace.targetName = resumeTarget.name;
    trace.translated = resumeClaim.translateAnthropic;
    const replayed = await serveResumedStreamSession({
      c,
      adapter,
      request: route.request,
      claim: resumeClaim,
      trace,
      recorder,
      inflight,
      responsePlan,
    });
    if (replayed) {
      return replayed;
    }
  }

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
    return traceDiagnosticResponse({
      c,
      adapter,
      request: route.request,
      trace,
      diagnostic: decision.diagnostic,
    });
  }
  trace.targetId = decision.target.id;
  trace.targetName = decision.target.name;
  trace.schedulerActions = [...decision.preview.plan.actions];
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
  const candidateInstanceId = candidatePlanTarget?.instanceId ?? null;
  const candidateInstance = candidateInstanceId
    ? getInstance(candidateInstanceId)
    : null;
  const candidateEngine = proxyEngineGates(candidateInstance);
  const requestLease = candidateEngine.requestLease;
  const leasePreemptible = requestLeasePreemptible(
    candidateInstance,
    decision.target.preemptible,
  );
  const domains = requestLease
    ? requestComputeDomains(candidatePlanTarget?.draws ?? [], planRequest.pools)
    : [];
  const parallelLimit = candidateInstance
    ? parseInstanceConcurrencyLimit(candidateInstance)
    : undefined;
  let lease: DomainLease | null = null;
  if (domains.length > 0) {
    try {
      lease = await computeDomainCoordinator.acquire({
        domains,
        targetId: decision.target.id,
        priority: decision.target.priority,
        preemptible: leasePreemptible,
        signal: c.req.raw.signal,
        decide: buildDomainAdmissionDecider({
          candidateTargetId: decision.target.id,
          candidatePriority: decision.target.priority,
          planRequest,
          ...(parallelLimit !== undefined ? { parallelLimit } : {}),
        }),
      });
    } catch {
      return traceDiagnosticResponse({
        c,
        adapter,
        request: route.request,
        trace,
        diagnostic: {
          status: 503,
          code: "arriero_proxy_upstream_unavailable",
          param: "model",
          message: `Request for model ${route.request.modelId} was aborted while queued.`,
        },
      });
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
  const observer = inflightStreamObserver(inflight, {
    onFirstToken: markFirstToken,
  });

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
      return {
        ok: false,
        response: traceDiagnosticResponse({
          c,
          adapter,
          request: route.request,
          trace,
          diagnostic: resolved.diagnostic,
        }),
      };
    }
    trace.translated = resolved.context.translateAnthropic;
    return { ok: true, context: resolved.context };
  };

  const markClientAbort = () =>
    markTraceClientAbort(
      trace,
      `Client closed the request before target ${decision.target.name} finished responding`,
    );

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
      return traceDiagnosticResponse({
        c,
        adapter,
        request: route.request,
        trace,
        diagnostic: execution.diagnostic,
      });
    }

    const resolved = resolveUpstreamContext();
    if (!resolved.ok) {
      return resolved.response;
    }
    const {
      baseUrl,
      instanceId,
      endpointId,
      engine,
      authHeaders,
      translateAnthropic,
      stripClientHeaders,
    } = resolved.context;
    const forward = prepareApiProxyUpstreamRequest({
      translate: translateAnthropic,
      operation,
      path: upstreamPath,
      body: route.request.body,
      headers: c.req.raw.headers,
      instanceId,
      endpointId,
      trace,
    });
    const upstreamRequestBody = forward.body;

    const streamMeter: StreamUsageMeter | null =
      route.request.stream && !translateAnthropic
        ? resolveStreamUsageMeter(operation, adapter, route.request.body)
        : null;
    const bufferCodec: ApiProxyResumableCodec | null =
      !route.request.stream &&
      instanceId !== null &&
      !translateAnthropic &&
      adapter.resumable &&
      operationSpec !== null &&
      operationSpec.resumable &&
      !requestBreaksStreamReconstruction(route.request.body)
        ? adapter.resumable
        : null;
    const injectUsage = translateAnthropic
      ? route.request.stream
      : (streamMeter?.inject ?? false);
    const wantsPrefillProgress =
      engine.sseTimings &&
      (translateAnthropic
        ? route.request.stream
        : streamMeter !== null &&
          operationSpec !== null &&
          operationSpec.promptProgress);
    const injectPrefillProgress =
      wantsPrefillProgress && !returnProgressRequested(upstreamRequestBody);
    let forwardBody: unknown;
    if (bufferCodec) {
      const built = bufferCodec.upstreamBody(upstreamRequestBody, null);
      forwardBody =
        returnProgressRequested(upstreamRequestBody) || !engine.sseTimings
          ? built
          : withReturnProgress(built);
    } else {
      forwardBody = injectUsage
        ? withIncludeUsage(upstreamRequestBody)
        : upstreamRequestBody;
      if (injectPrefillProgress) {
        forwardBody = withReturnProgress(forwardBody);
      }
    }

    const slotSeq =
      instanceId !== null && engine.sseTimings
        ? apiProxySlotTracker.mark(instanceId)
        : null;
    const resolveSlot = (): number | null => {
      if (instanceId !== null && slotSeq !== null) {
        const resolved = apiProxySlotTracker.resolve(instanceId, slotSeq);
        trace.slotId = resolved.slotId;
        trace.cacheOrigin = resolved.origin;
        return resolved.task;
      }
      return null;
    };

    const streamSession =
      instanceId !== null &&
      engine.streamResume &&
      operationSpec !== null &&
      operationSpec.resumable &&
      (route.request.stream || bufferCodec !== null)
        ? apiProxyStreamSessions.register({
            inflightId: inflight.id,
            instanceId,
            targetId: decision.target.id,
            modelId: route.request.modelId,
            baseUrl,
            authHeaders,
            protocol: operation.protocol,
            endpoint: operation.endpoint,
            stream: route.request.stream,
            resumeKey: apiProxyStreamResumeKey({
              instanceId,
              path: forward.path,
              modelId: decision.target.model ?? route.request.modelId,
              body: upstreamRequestBody,
            }),
          })
        : null;
    if (streamSession) {
      stopSignal.addEventListener(
        "abort",
        () => apiProxyStreamSessions.release(inflight.id),
        { once: true },
      );
    }

    try {
      markDispatched();
      const upstream = await forwardApiProxyRequest({
        baseUrl,
        method: c.req.method,
        upstreamPath: forward.path,
        search: new URL(c.req.url).search,
        headers: forward.headers,
        stripHeaders: stripClientHeaders,
        body: forwardBody,
        upstreamHeaders: streamSession
          ? { ...authHeaders, "x-conversation-id": streamSession.convId }
          : authHeaders,
        modelOverride: decision.target.model,
        signal: stopSignal,
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        if (text) {
          trace.errorMessage = upstreamErrorText(text);
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
            idleTimeoutMs: resolved.context.streamIdleTimeoutMs,
            consumerSignal: c.req.raw.signal,
            finishSignal: inflight.finishSignal(),
            cancelSignal: inflight.cancelSignal(),
            ...observer,
          });
          if (
            outcome.type === "consumer-gone" ||
            outcome.type === "cancelled"
          ) {
            markClientAbort();
            return new Response(null, { status: CLIENT_ABORT_STATUS });
          }
          if (outcome.type === "error") {
            return traceDiagnosticResponse({
              c,
              adapter,
              request: route.request,
              trace,
              diagnostic: {
                status: 502,
                code: "arriero_proxy_upstream_error",
                param: "model",
                message: `Proxy target ${decision.target.name} failed to forward request: ${outcome.message}`,
              },
            });
          }
          if (outcome.type === "truncated") {
            if (resolved.context.streamTerminal === "strict") {
              return truncatedStreamResponse({
                c,
                adapter,
                request: route.request,
                trace,
                state,
                label: `Proxy target ${decision.target.name} stream`,
              });
            }
            responsePlan?.markTruncated();
          }
          trace.usage = resumableTraceUsage(state);
          applyProxyStreamHealth({ trace, health: state.health });
          const task = resolveSlot();
          const final = finalFromState(bufferCodec, state, false);
          const delivered = applyApiProxyResponsePlanText(
            responsePlan,
            final.body,
            {
              status: final.status,
              contentType: final.headers["content-type"] ?? "application/json",
              isSse: false,
            },
          );
          return recordTraceWithDeferredTiming({
            recorder,
            trace,
            instanceId,
            task,
            response: new Response(delivered, {
              status: final.status,
              headers: final.headers,
            }),
          });
        }
        const text = await upstream.text();
        const usage = usageFromNonStreamBody(forward.protocol, text);
        if (usage) {
          trace.usage = traceUsageFromCounts(usage);
        }
        const task = resolveSlot();
        const translatedText = translateAnthropic
          ? translateOpenAiResponseText(text)
          : null;
        const clientText = translatedText ?? text;
        const clientContentType = translatedText
          ? "application/json"
          : (upstream.headers.get("content-type") ?? "application/json");
        const delivered = applyApiProxyResponsePlanText(
          responsePlan,
          clientText,
          {
            status: upstream.status,
            contentType: clientContentType,
            isSse: false,
          },
        );
        const nonStreamResponse =
          translatedText !== null
            ? new Response(delivered, {
                status: upstream.status,
                headers: { "content-type": "application/json" },
              })
            : new Response(delivered, {
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

      const streamBody = watchStreamIdle(
        upstream.body,
        resolved.context.streamIdleTimeoutMs,
        (error) => {
          trace.errorCode = "arriero_proxy_upstream_timeout";
          trace.errorMessage = `Proxy target ${decision.target.name}: ${error.message}`;
        },
      );

      const finishStreamResponse = (
        observed: ReadableStream<Uint8Array>,
        status: number,
        headers: Headers,
        statusText?: string,
      ): Response => {
        const responseInit: ResponseInit = statusText
          ? { status, headers, statusText }
          : { status, headers };
        return decoupledStreamResponse(observed, streamOwnerKey, responseInit);
      };

      let metered: Response | undefined;
      const onStreamComplete = (usage: ProxyUsageCounts) => {
        recorder.freezeDuration();
        trace.usage = traceUsageFromCounts(usage);
        const task = resolveSlot();
        void applyServerGenerationTiming(trace, instanceId, task).finally(() =>
          recorder.record(metered),
        );
      };

      if (translateAnthropic) {
        const translation = createAnthropicTranslationStream({
          ...observer,
          onComplete: onStreamComplete,
        });
        recorder.markDeferred();
        metered = finishStreamResponse(
          observeBodyCompletion(
            tapApiProxyResponsePlanStream(
              responsePlan,
              streamBody.pipeThrough(translation.transform),
              upstream.status,
              upstream.headers,
            ),
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
          observeBodyCompletion(
            tapApiProxyResponsePlanStream(
              responsePlan,
              streamBody,
              upstream.status,
              upstream.headers,
            ),
            () => recorder.record(upstream),
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
        onStreamEnd: markPlanTruncatedOnEof(responsePlan),
        ...observer,
        onComplete: onStreamComplete,
      });
      recorder.markDeferred();
      metered = finishStreamResponse(
        observeBodyCompletion(
          tapApiProxyResponsePlanStream(
            responsePlan,
            streamBody.pipeThrough(meter.transform),
            upstream.status,
            upstream.headers,
          ),
          () => {
            applyProxyStreamHealth({ trace, health: meter.health() });
            meter.finalize();
          },
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
      return traceDiagnosticResponse({
        c,
        adapter,
        request: route.request,
        trace,
        diagnostic: {
          status: 502,
          code: "arriero_proxy_upstream_error",
          param: "model",
          message: `Proxy target ${decision.target.name} failed to forward request: ${describeFetchError(error)}`,
        },
      });
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
    const {
      baseUrl,
      instanceId,
      endpointId,
      engine,
      authHeaders,
      translateAnthropic,
    } = resolved.context;
    const forward = prepareApiProxyUpstreamRequest({
      translate: translateAnthropic,
      operation,
      path: upstreamPath,
      body: route.request.body,
      headers: c.req.raw.headers,
      instanceId,
      endpointId,
      trace,
    });
    const upstreamRequestBody = forward.body;
    const effectiveCodec = translateAnthropic
      ? translatedAnthropicResumableCodec(upstreamRequestBody)
      : codec;
    const url = apiProxyForwardUrl(
      baseUrl,
      forward.path,
      new URL(c.req.url).search,
    );
    const slotSeq =
      instanceId !== null && engine.sseTimings
        ? apiProxySlotTracker.mark(instanceId)
        : null;
    const injectPrefillProgress =
      (operation.protocol === "openai" || translateAnthropic) &&
      engine.sseTimings &&
      !returnProgressRequested(route.request.body);
    const forceAnswerSupported =
      instanceId !== null &&
      (operation.protocol === "openai" || translateAnthropic);
    inflight.setInterruptible(forceAnswerSupported);
    const buildForceAnswerTail = forceAnswerSupported
      ? (reasoningText: string): string | null =>
          buildThinkForceAnswerTail(reasoningText)
      : undefined;
    const state = createResumableBufferState();
    const buildBody = (tail: string | null) => {
      const built = effectiveCodec.upstreamBody(
        upstreamRequestBody,
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
        applyTraceDiagnostic(trace, execution.diagnostic);
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
          idleTimeoutMs: resolved.context.streamIdleTimeoutMs,
          ...observer,
        });
      },
      state,
      codec: effectiveCodec,
      yieldLease: () => heldLease.yield(),
      wantsStream: route.request.stream,
      truncation: {
        mode:
          resolved.context.streamTerminal === "tolerant"
            ? "accept"
            : instanceId !== null
              ? "resume"
              : "error",
      },
      ...(buildForceAnswerTail ? { buildForceAnswerTail } : {}),
      onError: (message) => {
        const diagnostic: ApiProxyProtocolDiagnostic = {
          status: 502,
          code: "arriero_proxy_upstream_error",
          param: "model",
          message: `Proxy target ${decision.target.name} failed to forward request: ${message}`,
        };
        applyTraceDiagnostic(trace, diagnostic);
        const response = adapter.diagnosticError(route.request, diagnostic);
        return {
          status: response.status,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(response.body),
        };
      },
    });

    trace.usage = resumableTraceUsage(state);
    applyProxyStreamHealth({ trace, health: state.health });
    if (state.health.terminal === "eof") {
      responsePlan?.markTruncated();
    }
    let task: number | null = null;
    if (instanceId !== null && slotSeq !== null) {
      const resolved = apiProxySlotTracker.resolve(instanceId, slotSeq);
      trace.slotId = resolved.slotId;
      trace.cacheOrigin = resolved.origin;
      task = resolved.task;
    }

    if (final.status === CLIENT_ABORT_STATUS) {
      markClientAbort();
    }
    const responseBody = applyApiProxyResponsePlanText(
      responsePlan,
      final.body,
      {
        status: final.status,
        contentType:
          final.headers["content-type"] ??
          (route.request.stream ? "text/event-stream" : "application/json"),
        isSse: route.request.stream,
      },
    );
    return recordTraceWithDeferredTiming({
      recorder,
      trace,
      instanceId,
      task,
      response: new Response(responseBody, {
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
    candidateEngine.streamResume &&
    leasePreemptible &&
    adapter.resumable &&
    operationSpec !== null &&
    operationSpec.resumable &&
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
