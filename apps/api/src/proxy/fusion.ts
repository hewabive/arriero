import type {
  ApiProxyFusionConfig,
  ApiProxyModelRecord,
  ApiProxyPipelineRecord,
  ApiProxyPortRef,
  ApiProxyRouteTraceStep,
  ApiProxyTargetRecord,
} from "@arriero/core";

import { adapterForProtocol } from "./protocol-adapters.js";
import { buildDomainAdmissionDecider } from "./domain-admission.js";
import {
  computeDomainCoordinator,
  type DomainLease,
} from "./domain-coordinator.js";
import { apiProxyForwardUrl } from "./forwarder.js";
import {
  buildApiProxyPlanRequest,
  getApiProxyPlanPreview,
} from "./idle-maintenance.js";
import { requestComputeDomains } from "./resource-domains.js";
import { asObject, isRecord } from "./json.js";
import {
  resolveApiProxyRouteChain,
  type ApiProxyCacheLookup,
  type ApiProxyFusionNode,
  type ApiProxyPipelineRecordRequestInput,
  type ApiProxyResponseEffect,
} from "./pipeline.js";
import {
  bodyRequestsStreaming,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
  type ApiProxyResumableFinalResponse,
} from "./protocol.js";
import { safeJsonParse, type ProxyTraceAccumulator } from "./protocol-trace.js";
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
import { getApiProxyPipeline, getApiProxyTarget } from "./repository.js";
import {
  createApiProxyResponsePlanExecutor,
  settleAbandonedApiProxyCacheEffects,
  type ApiProxyResponseCacheWriter,
} from "./response-plan.js";
import {
  createResumableBufferState,
  finalFromState,
  runResumableUpstreamAttempt,
  type ResumableBufferState,
} from "./resumable-forward.js";
import { applyProxyStreamHealth } from "./stream-health.js";
import { executeApiProxyTargetReadiness } from "./target-lifecycle.js";
import { translatedAnthropicResumableCodec } from "./translation.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

const maxFusionDepth = 3;

const neverAbort = new AbortController().signal;

export type ApiProxyModelSubRequestResult =
  | {
      ok: true;
      state: ResumableBufferState;
      codec: ApiProxyResumableCodec;
      target: ApiProxyTargetRecord;
      translateAnthropic: boolean;
    }
  | { ok: false; diagnostic: ApiProxyProtocolDiagnostic };

export async function executeApiProxyModelSubRequest(input: {
  targetId: string;
  operation: ApiProxyProtocolOperation;
  body: unknown;
  model: ApiProxyModelRecord;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<ApiProxyModelSubRequestResult> {
  const fail = (
    diagnostic: ApiProxyProtocolDiagnostic,
  ): ApiProxyModelSubRequestResult => ({ ok: false, diagnostic });

  const adapter = adapterForProtocol(input.operation.protocol);
  const upstreamPath = adapter.upstreamPath(input.operation);
  if (!upstreamPath || !adapter.resumable) {
    return fail({
      status: 501,
      code: "arriero_proxy_route_invalid",
      message: `fusion sub-requests support only chat/messages, not ${input.operation.endpoint}`,
    });
  }

  const target = getApiProxyTarget(input.targetId);
  if (!target) {
    return fail({
      status: 503,
      code: "arriero_proxy_route_invalid",
      message: `fusion branch target ${input.targetId} not found`,
    });
  }

  const { request: planRequest } = await buildApiProxyPlanRequest({
    mode: "request",
    requestedTargetId: target.id,
  });
  const candidatePlanTarget = planRequest.targets.find(
    (item) => item.id === target.id,
  );
  const domains = requestComputeDomains(
    candidatePlanTarget?.draws ?? [],
    planRequest.pools,
  );
  let lease: DomainLease | null = null;
  if (domains.length > 0) {
    try {
      lease = await computeDomainCoordinator.acquire({
        domains,
        targetId: target.id,
        priority: target.priority,
        preemptible: false,
        ...(input.signal ? { signal: input.signal } : {}),
        decide: buildDomainAdmissionDecider({
          candidateTargetId: target.id,
          candidatePriority: target.priority,
          planRequest,
        }),
      });
    } catch {
      return fail({
        status: 503,
        code: "arriero_proxy_upstream_error",
        message: `fusion branch target ${target.name} was aborted while queued`,
      });
    }
  }

  try {
    const preview = await getApiProxyPlanPreview({
      mode: "request",
      requestedTargetId: target.id,
    });
    const ready = await executeApiProxyTargetReadiness(
      target,
      preview,
      domains,
      undefined,
      input.signal,
    );
    if (!ready.ok) {
      return fail(ready.diagnostic);
    }

    const upstream = resolveApiProxyUpstreamContext({
      target,
      operation: input.operation,
    });
    if (!upstream.ok) {
      return fail(upstream.diagnostic);
    }
    const { baseUrl, authHeaders, translateAnthropic } = upstream.context;

    const forward = prepareApiProxyUpstreamRequest({
      translate: translateAnthropic,
      translationDialect: upstream.context.translationDialect,
      operation: input.operation,
      path: upstreamPath,
      body: input.body,
      headers: new Headers(),
      instanceId: upstream.context.instanceId,
      endpointId: upstream.context.endpointId,
    });
    const codec = translateAnthropic
      ? translatedAnthropicResumableCodec(forward.body)
      : adapter.resumable;
    const url = apiProxyForwardUrl(baseUrl, forward.path, "");
    const state = createResumableBufferState();
    const built = codec.upstreamBody(forward.body, null);
    const requestBody =
      target.model && built && typeof built === "object"
        ? { ...(built as Record<string, unknown>), model: target.model }
        : built;

    const outcome = await runResumableUpstreamAttempt({
      url,
      method: "POST",
      headers: authHeaders,
      body: requestBody,
      codec,
      state,
      idleTimeoutMs: upstream.context.streamIdleTimeoutMs,
      preemptSignal: lease?.preemptSignal ?? neverAbort,
      ...(input.signal ? { consumerSignal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });

    if (outcome.type === "completed") {
      return { ok: true, state, codec, target, translateAnthropic };
    }
    if (outcome.type === "truncated") {
      return fail({
        status: 502,
        code: "arriero_proxy_upstream_error",
        message: `fusion branch target ${target.name} stream ended without a terminal chunk`,
      });
    }
    if (outcome.type === "consumer-gone") {
      return fail({
        status: 503,
        code: "arriero_proxy_upstream_error",
        message: `fusion branch target ${target.name} was aborted by the client`,
      });
    }
    if (
      outcome.type === "preempted" ||
      outcome.type === "interrupted" ||
      outcome.type === "finished" ||
      outcome.type === "cancelled"
    ) {
      return fail({
        status: 503,
        code: "arriero_proxy_upstream_error",
        message: `fusion branch target ${target.name} was ${outcome.type}`,
      });
    }
    return fail({
      status: 502,
      code: "arriero_proxy_upstream_error",
      message: `fusion branch target ${target.name} failed: ${outcome.message}`,
    });
  } finally {
    lease?.release();
  }
}

type PanelAnswer = {
  state: ResumableBufferState;
  codec: ApiProxyResumableCodec;
  responseEffects: ApiProxyResponseEffect[];
};

type ApiProxyFusionBranchTrace = {
  branch: string;
  detail: string | null;
  routeTrace: ApiProxyRouteTraceStep[];
  textReplacementCount: number;
};

export type ApiProxyFusionChainIo = {
  trace: ProxyTraceAccumulator;
  putCache: ApiProxyResponseCacheWriter;
  recordRequest?:
    | ((request: ApiProxyPipelineRecordRequestInput) => void | Promise<void>)
    | undefined;
  lookupCache?: ApiProxyCacheLookup | undefined;
  registerOwner?: ((key: string) => void) | undefined;
  ownedKeys?: Set<string> | undefined;
};

type PanelOutcome =
  | ({ ok: true } & PanelAnswer & { trace: ApiProxyFusionBranchTrace })
  | { ok: false; error: string; trace: ApiProxyFusionBranchTrace };

export type ApiProxyFusionOutcome =
  | {
      kind: "route";
      targetId: string;
      request: ApiProxyProtocolModelRequest;
      responseEffects: ApiProxyResponseEffect[];
      branches: ApiProxyFusionBranchTrace[];
    }
  | {
      kind: "direct";
      response: ApiProxyResumableFinalResponse;
      responseEffects: ApiProxyResponseEffect[];
      branches: ApiProxyFusionBranchTrace[];
    }
  | {
      kind: "error";
      diagnostic: ApiProxyProtocolDiagnostic;
      branches: ApiProxyFusionBranchTrace[];
    };

function fusionDiagnostic(message: string): ApiProxyProtocolDiagnostic {
  return { status: 502, code: "arriero_proxy_upstream_error", message };
}

function bufferedPanelBody(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  if (!("stream" in body) && !("stream_options" in body)) {
    return body;
  }
  const next = { ...body };
  delete next.stream;
  delete next.stream_options;
  return next;
}

function applyFinalBodyToState(
  state: ResumableBufferState,
  protocol: ApiProxyProtocolOperation["protocol"],
  body: string,
): boolean {
  const parsed = safeJsonParse(body);
  if (!isRecord(parsed)) {
    return false;
  }
  if (protocol === "anthropic") {
    const content = Array.isArray(parsed.content) ? parsed.content : null;
    if (!content) {
      return false;
    }
    state.text = content
      .map((block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("");
    state.reasoningText = content
      .map((block) =>
        isRecord(block) &&
        block.type === "thinking" &&
        typeof block.thinking === "string"
          ? block.thinking
          : "",
      )
      .join("");
    if (typeof parsed.id === "string") {
      state.id = parsed.id;
    }
    if (typeof parsed.model === "string") {
      state.model = parsed.model;
    }
    if (typeof parsed.stop_reason === "string") {
      state.finishReason = parsed.stop_reason;
    }
    const usage = asObject(parsed.usage);
    if (usage) {
      if (typeof usage.input_tokens === "number") {
        state.promptTokens = usage.input_tokens;
      }
      if (typeof usage.output_tokens === "number") {
        state.completionTokens = usage.output_tokens;
      }
    }
    return true;
  }
  const choice = Array.isArray(parsed.choices)
    ? asObject(parsed.choices[0])
    : null;
  const message = choice ? asObject(choice.message) : null;
  if (!message) {
    return false;
  }
  if (typeof message.content === "string") {
    state.text = message.content;
  } else if (message.content === null) {
    state.text = "";
  }
  if (typeof message.reasoning_content === "string") {
    state.reasoningText = message.reasoning_content;
  }
  if (typeof parsed.id === "string") {
    state.id = parsed.id;
  }
  if (typeof parsed.model === "string") {
    state.model = parsed.model;
  }
  if (choice && typeof choice.finish_reason === "string") {
    state.finishReason = choice.finish_reason;
  }
  const usage = asObject(parsed.usage);
  if (usage) {
    if (typeof usage.prompt_tokens === "number") {
      state.promptTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      state.completionTokens = usage.completion_tokens;
    }
  }
  return true;
}

function buildFusionSynthBody(input: {
  protocol: ApiProxyProtocolOperation["protocol"];
  originalBody: unknown;
  answers: string[];
  config: ApiProxyFusionConfig;
}): unknown {
  const base =
    input.originalBody &&
    typeof input.originalBody === "object" &&
    !Array.isArray(input.originalBody)
      ? (input.originalBody as Record<string, unknown>)
      : {};
  const originalMessages = Array.isArray(base.messages) ? base.messages : [];
  const answersBlock = [
    input.config.answersTemplate,
    "",
    ...input.answers.map(
      (answer, index) => `### Answer ${index + 1}\n${answer}`,
    ),
  ].join("\n");
  const answersMessage = { role: "user", content: answersBlock };

  if (input.protocol === "anthropic") {
    const baseSystem = base.system;
    const system =
      typeof baseSystem === "string" && baseSystem.length > 0
        ? `${input.config.synthesizerPrompt}\n\n${baseSystem}`
        : Array.isArray(baseSystem)
          ? [
              { type: "text", text: input.config.synthesizerPrompt },
              ...baseSystem,
            ]
          : input.config.synthesizerPrompt;
    return {
      ...base,
      system,
      messages: [...originalMessages, answersMessage],
    };
  }

  return {
    ...base,
    messages: [
      { role: "system", content: input.config.synthesizerPrompt },
      ...originalMessages,
      answersMessage,
    ],
  };
}

function bypassResponse(
  answer: PanelAnswer,
  wantsStream: boolean,
): ApiProxyResumableFinalResponse {
  return answer.codec.finalResponse({
    text: answer.state.text,
    id: answer.state.id,
    model: answer.state.model,
    finishReason: answer.state.finishReason,
    wantsStream,
    reasoningText: answer.state.reasoningText,
    completionTokens: answer.state.completionTokens,
    promptTokens: answer.state.promptTokens,
    genMs: answer.state.genMs,
    toolCalls: answer.state.toolCalls,
  });
}

export async function executeApiProxyFusion(input: {
  node: ApiProxyFusionNode;
  pipeline: ApiProxyPipelineRecord;
  request: ApiProxyProtocolModelRequest;
  sourceId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  depth?: number | undefined;
  io?: ApiProxyFusionChainIo | undefined;
}): Promise<ApiProxyFusionOutcome> {
  const operation = input.request.operation;
  const depth = input.depth ?? 0;
  const io = input.io;
  const ownedKeys = io?.ownedKeys ?? new Set<string>();

  const rawLookup = io?.lookupCache;
  const bufferedLookup: ApiProxyCacheLookup | undefined = rawLookup
    ? async (key) => {
        const cached = await rawLookup(key);
        return cached && !cached.isSse ? cached : null;
      }
    : undefined;
  const registerOwner = io?.registerOwner;
  const registerBranchOwner = registerOwner
    ? (key: string) => {
        ownedKeys.add(key);
        registerOwner(key);
      }
    : undefined;

  const resolveBranch = (
    ref: ApiProxyPortRef,
    request: ApiProxyProtocolModelRequest,
    useBufferedCache: boolean,
  ) =>
    resolveApiProxyRouteChain({
      request,
      getPipeline: getApiProxyPipeline,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      entry: { ref, pipeline: input.pipeline },
      ...(io?.recordRequest ? { recordRequest: io.recordRequest } : {}),
      ...(useBufferedCache && bufferedLookup
        ? { lookupCache: bufferedLookup }
        : {}),
      ...(registerBranchOwner ? { registerOwner: registerBranchOwner } : {}),
      ownedKeys,
    });

  const applyPanelEffects = (answer: PanelAnswer): number => {
    if (!io || answer.responseEffects.length === 0) {
      return 0;
    }
    const plan = createApiProxyResponsePlanExecutor({
      effects: answer.responseEffects,
      putCache: io.putCache,
      trace: io.trace,
      operation,
    });
    if (!plan) {
      return 0;
    }
    const before = io.trace.textReplacementCount;
    const final = finalFromState(answer.codec, answer.state, false);
    const transformed = plan.processText(final.body, {
      status: 200,
      contentType: final.headers["content-type"] ?? "application/json",
      isSse: false,
    });
    plan.flush();
    if (transformed !== final.body) {
      applyFinalBodyToState(answer.state, operation.protocol, transformed);
    }
    return io.trace.textReplacementCount - before;
  };

  const panelRequest: ApiProxyProtocolModelRequest = {
    ...input.request,
    body: bufferedPanelBody(input.request.body),
    stream: false,
  };

  const runPanelBranch = async (
    ref: ApiProxyPortRef,
    label: string,
  ): Promise<PanelOutcome> => {
    const branchTrace = (
      detail: string | null,
      routeTrace: ApiProxyRouteTraceStep[],
      textReplacementCount = 0,
    ): ApiProxyFusionBranchTrace => ({
      branch: label,
      detail,
      routeTrace,
      textReplacementCount,
    });
    const failBranch = (
      error: string,
      resolved: {
        responseEffects: ApiProxyResponseEffect[];
        routeTrace: ApiProxyRouteTraceStep[];
      },
      textReplacementCount = 0,
    ): PanelOutcome => {
      settleAbandonedApiProxyCacheEffects(resolved.responseEffects, error);
      return {
        ok: false,
        error,
        trace: branchTrace(error, resolved.routeTrace, textReplacementCount),
      };
    };

    const resolved = await resolveBranch(ref, panelRequest, true);
    if (!resolved.ok) {
      return failBranch(resolved.diagnostic.message, resolved);
    }
    if (resolved.kind === "fusion") {
      return failBranch(
        "panel branch resolves to a nested fusion node (unsupported)",
        resolved,
        resolved.textReplacementCount,
      );
    }
    if (resolved.kind === "endpoint") {
      return failBranch(
        "panel branch resolves to an external endpoint (unsupported)",
        resolved,
        resolved.textReplacementCount,
      );
    }
    if (resolved.kind === "response") {
      if (typeof resolved.response.body !== "string") {
        return failBranch(
          "panel branch resolved to a streamed response (unsupported)",
          resolved,
        );
      }
      const codec = adapterForProtocol(operation.protocol).resumable;
      if (!codec) {
        return failBranch(
          "panel branch protocol has no buffered codec",
          resolved,
        );
      }
      const state = createResumableBufferState();
      if (
        !applyFinalBodyToState(
          state,
          operation.protocol,
          resolved.response.body,
        )
      ) {
        return failBranch(
          "panel branch cache entry is not a parseable answer",
          resolved,
        );
      }
      return {
        ok: true,
        state,
        codec,
        responseEffects: resolved.responseEffects,
        trace: branchTrace(
          "cached answer",
          resolved.routeTrace,
          resolved.textReplacementCount,
        ),
      };
    }
    const sub = await executeApiProxyModelSubRequest({
      targetId: resolved.targetId,
      operation,
      body: resolved.request.body,
      model: resolved.request.model,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (!sub.ok) {
      return failBranch(
        sub.diagnostic.message,
        resolved,
        resolved.textReplacementCount,
      );
    }
    if (io) {
      applyProxyStreamHealth({
        trace: io.trace,
        health: sub.state.health,
        targetName: sub.target.name,
      });
    }
    return {
      ok: true,
      state: sub.state,
      codec: sub.codec,
      responseEffects: resolved.responseEffects,
      trace: branchTrace(
        "answered",
        resolved.routeTrace,
        resolved.textReplacementCount,
      ),
    };
  };

  const panelRefs = input.node.ports.panel;
  if (panelRefs.length === 0) {
    return {
      kind: "error",
      diagnostic: fusionDiagnostic("fusion node has no panel branches wired"),
      branches: [],
    };
  }

  const settled = await Promise.all(
    panelRefs.map((ref, index) => runPanelBranch(ref, `panel ${index + 1}`)),
  );
  const branches: ApiProxyFusionBranchTrace[] = settled.map(
    (outcome) => outcome.trace,
  );
  const survivors = settled.filter(
    (outcome): outcome is Extract<PanelOutcome, { ok: true }> => outcome.ok,
  );
  const failures = settled
    .filter((outcome) => !outcome.ok)
    .map((outcome) => (outcome.ok ? "" : outcome.error));

  const minQuorum = input.node.config.minQuorum;
  if (survivors.length < minQuorum) {
    const message = `fusion quorum not met: ${survivors.length}/${minQuorum} panel branch(es) answered`;
    for (const survivor of survivors) {
      settleAbandonedApiProxyCacheEffects(survivor.responseEffects, message);
    }
    const detail = failures.length ? ` (failures: ${failures.join("; ")})` : "";
    return {
      kind: "error",
      diagnostic: fusionDiagnostic(`${message}${detail}`),
      branches,
    };
  }

  if (survivors.length === 1) {
    const only = survivors[0];
    if (only) {
      return {
        kind: "direct",
        response: bypassResponse(only, input.request.stream),
        responseEffects: only.responseEffects,
        branches,
      };
    }
  }

  const synthPort = input.node.ports.synthesizer;
  if (!synthPort) {
    const message = "fusion synthesizer port is not wired";
    for (const survivor of survivors) {
      settleAbandonedApiProxyCacheEffects(survivor.responseEffects, message);
    }
    return {
      kind: "error",
      diagnostic: fusionDiagnostic(message),
      branches,
    };
  }

  for (const survivor of survivors) {
    survivor.trace.textReplacementCount += applyPanelEffects(survivor);
  }

  const synthBody = buildFusionSynthBody({
    protocol: operation.protocol,
    originalBody: input.request.body,
    answers: survivors.map((survivor) => survivor.state.text),
    config: input.node.config,
  });
  const synthRequest: ApiProxyProtocolModelRequest = {
    operation,
    body: synthBody,
    modelId: input.request.modelId,
    model: input.request.model,
    stream: bodyRequestsStreaming(synthBody),
  };

  const synthBranch = (
    detail: string | null,
    routeTrace: ApiProxyRouteTraceStep[],
    textReplacementCount = 0,
  ): ApiProxyFusionBranchTrace => ({
    branch: "synthesizer",
    detail,
    routeTrace,
    textReplacementCount,
  });

  const synthRoute = await resolveBranch(synthPort, synthRequest, false);
  if (!synthRoute.ok) {
    settleAbandonedApiProxyCacheEffects(
      synthRoute.responseEffects,
      synthRoute.diagnostic.message,
    );
    branches.push(
      synthBranch(synthRoute.diagnostic.message, synthRoute.routeTrace),
    );
    return { kind: "error", diagnostic: synthRoute.diagnostic, branches };
  }
  if (synthRoute.kind === "endpoint" || synthRoute.kind === "response") {
    const message =
      synthRoute.kind === "endpoint"
        ? "fusion synthesizer resolves to an external endpoint (unsupported)"
        : "fusion synthesizer resolves to a cached response (unsupported)";
    settleAbandonedApiProxyCacheEffects(synthRoute.responseEffects, message);
    branches.push(
      synthBranch(
        message,
        synthRoute.routeTrace,
        synthRoute.textReplacementCount,
      ),
    );
    return { kind: "error", diagnostic: fusionDiagnostic(message), branches };
  }
  if (synthRoute.kind === "fusion") {
    if (depth >= maxFusionDepth) {
      const message = `fusion nesting exceeded depth ${maxFusionDepth}`;
      settleAbandonedApiProxyCacheEffects(synthRoute.responseEffects, message);
      branches.push(
        synthBranch(
          message,
          synthRoute.routeTrace,
          synthRoute.textReplacementCount,
        ),
      );
      return { kind: "error", diagnostic: fusionDiagnostic(message), branches };
    }
    branches.push(
      synthBranch(
        "nested fusion",
        synthRoute.routeTrace,
        synthRoute.textReplacementCount,
      ),
    );
    const nested = await executeApiProxyFusion({
      node: synthRoute.node,
      pipeline: synthRoute.pipeline,
      request: synthRoute.request,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      depth: depth + 1,
      ...(io ? { io } : {}),
    });
    const mergedBranches = [...branches, ...nested.branches];
    if (nested.kind === "error") {
      settleAbandonedApiProxyCacheEffects(
        synthRoute.responseEffects,
        nested.diagnostic.message,
      );
      return { ...nested, branches: mergedBranches };
    }
    return {
      ...nested,
      responseEffects: [
        ...synthRoute.responseEffects,
        ...nested.responseEffects,
      ],
      branches: mergedBranches,
    };
  }
  branches.push(
    synthBranch(
      "routed",
      synthRoute.routeTrace,
      synthRoute.textReplacementCount,
    ),
  );
  return {
    kind: "route",
    targetId: synthRoute.targetId,
    request: synthRoute.request,
    responseEffects: synthRoute.responseEffects,
    branches,
  };
}
