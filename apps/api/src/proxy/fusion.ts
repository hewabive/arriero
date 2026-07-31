import type {
  ApiProxyFusionConfig,
  ApiProxyPipelineRecord,
  ApiProxyPortRef,
  ApiProxyTargetRecord,
} from "@arriero/core";

import { anthropicProtocolAdapter } from "./anthropic.js";
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
import { openAiProtocolAdapter } from "./openai.js";
import {
  resolveApiProxyRouteChain,
  type ApiProxyFusionNode,
} from "./pipeline.js";
import {
  bodyRequestsStreaming,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
  type ApiProxyResumableFinalResponse,
} from "./protocol.js";
import { getApiProxyPipeline, getApiProxyTarget } from "./repository.js";
import {
  createResumableBufferState,
  runResumableUpstreamAttempt,
  type ResumableBufferState,
} from "./resumable-forward.js";
import { executeApiProxyTargetReadiness } from "./target-lifecycle.js";
import {
  prepareUpstreamExchange,
  translatedAnthropicResumableCodec,
} from "./translation.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

const maxFusionDepth = 3;

const neverAbort = new AbortController().signal;

function adapterForProtocol(
  protocol: ApiProxyProtocolOperation["protocol"],
): ApiProxyProtocolAdapter {
  return protocol === "anthropic"
    ? anthropicProtocolAdapter
    : openAiProtocolAdapter;
}

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

    const exchange = prepareUpstreamExchange({
      translate: translateAnthropic,
      operation: input.operation,
      path: upstreamPath,
      body: input.body,
      headers: new Headers(),
    });
    const codec = translateAnthropic
      ? translatedAnthropicResumableCodec(exchange.body)
      : adapter.resumable;
    const url = apiProxyForwardUrl(baseUrl, exchange.path, "");
    const state = createResumableBufferState();
    const built = codec.upstreamBody(exchange.body, null);
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
      preemptSignal: lease?.preemptSignal ?? neverAbort,
      ...(input.signal ? { consumerSignal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });

    if (outcome.type === "completed") {
      return { ok: true, state, codec, target, translateAnthropic };
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
};

type PanelOutcome = ({ ok: true } & PanelAnswer) | { ok: false; error: string };

export type ApiProxyFusionOutcome =
  | { kind: "route"; targetId: string; request: ApiProxyProtocolModelRequest }
  | { kind: "direct"; response: ApiProxyResumableFinalResponse }
  | { kind: "error"; diagnostic: ApiProxyProtocolDiagnostic };

function fusionDiagnostic(message: string): ApiProxyProtocolDiagnostic {
  return { status: 502, code: "arriero_proxy_upstream_error", message };
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
    const originalSystem = typeof base.system === "string" ? base.system : null;
    return {
      ...base,
      system: originalSystem
        ? `${input.config.synthesizerPrompt}\n\n${originalSystem}`
        : input.config.synthesizerPrompt,
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
}): Promise<ApiProxyFusionOutcome> {
  const operation = input.request.operation;
  const depth = input.depth ?? 0;

  const resolveBranch = (
    ref: ApiProxyPortRef,
    request: ApiProxyProtocolModelRequest,
  ) =>
    resolveApiProxyRouteChain({
      request,
      getPipeline: getApiProxyPipeline,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      entry: { ref, pipeline: input.pipeline },
    });

  const runPanelBranch = async (
    ref: ApiProxyPortRef,
  ): Promise<PanelOutcome> => {
    const resolved = await resolveBranch(ref, input.request);
    if (!resolved.ok) {
      return { ok: false, error: resolved.diagnostic.message };
    }
    if (resolved.kind === "fusion") {
      return {
        ok: false,
        error: "panel branch resolves to a nested fusion node (unsupported)",
      };
    }
    if (resolved.kind === "endpoint") {
      return {
        ok: false,
        error: "panel branch resolves to an external endpoint (unsupported)",
      };
    }
    if (resolved.kind === "response") {
      return {
        ok: false,
        error: "panel branch resolves to a cached response (unsupported)",
      };
    }
    const sub = await executeApiProxyModelSubRequest({
      targetId: resolved.targetId,
      operation,
      body: resolved.request.body,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (!sub.ok) {
      return { ok: false, error: sub.diagnostic.message };
    }
    return { ok: true, state: sub.state, codec: sub.codec };
  };

  const panelRefs = input.node.ports.panel;
  if (panelRefs.length === 0) {
    return {
      kind: "error",
      diagnostic: fusionDiagnostic("fusion node has no panel branches wired"),
    };
  }

  const settled = await Promise.all(panelRefs.map(runPanelBranch));
  const survivors = settled.filter(
    (outcome): outcome is { ok: true } & PanelAnswer => outcome.ok,
  );
  const failures = settled
    .filter((outcome) => !outcome.ok)
    .map((outcome) => (outcome.ok ? "" : outcome.error));

  const minQuorum = input.node.config.minQuorum;
  if (survivors.length < minQuorum) {
    const detail = failures.length ? ` (failures: ${failures.join("; ")})` : "";
    return {
      kind: "error",
      diagnostic: fusionDiagnostic(
        `fusion quorum not met: ${survivors.length}/${minQuorum} panel branch(es) answered${detail}`,
      ),
    };
  }

  if (survivors.length === 1) {
    const only = survivors[0];
    if (only) {
      return {
        kind: "direct",
        response: bypassResponse(only, input.request.stream),
      };
    }
  }

  const synthPort = input.node.ports.synthesizer;
  if (!synthPort) {
    return {
      kind: "error",
      diagnostic: fusionDiagnostic("fusion synthesizer port is not wired"),
    };
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

  const synthRoute = await resolveBranch(synthPort, synthRequest);
  if (!synthRoute.ok) {
    return { kind: "error", diagnostic: synthRoute.diagnostic };
  }
  if (synthRoute.kind === "endpoint") {
    return {
      kind: "error",
      diagnostic: fusionDiagnostic(
        "fusion synthesizer resolves to an external endpoint (unsupported)",
      ),
    };
  }
  if (synthRoute.kind === "response") {
    return {
      kind: "error",
      diagnostic: fusionDiagnostic(
        "fusion synthesizer resolves to a cached response (unsupported)",
      ),
    };
  }
  if (synthRoute.kind === "fusion") {
    if (depth >= maxFusionDepth) {
      return {
        kind: "error",
        diagnostic: fusionDiagnostic(
          `fusion nesting exceeded depth ${maxFusionDepth}`,
        ),
      };
    }
    return executeApiProxyFusion({
      node: synthRoute.node,
      pipeline: synthRoute.pipeline,
      request: synthRoute.request,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      depth: depth + 1,
    });
  }
  return {
    kind: "route",
    targetId: synthRoute.targetId,
    request: synthRoute.request,
  };
}
