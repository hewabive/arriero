import {
  apiProxyReasoningDirectiveOperations,
  apiProxyReasoningExtractionDetail,
  applyApiProxyRequestEdits,
  extractApiProxyReasoningDirective,
  resolveApiProxyReasoningProfile,
  stripApiProxyReasoningFields,
  type ApiProxyRouteTraceStep,
  type ApiProxyUpstreamReasoningProfile,
  type EngineTranslationDialectId,
} from "@arriero/core";

import { instanceReasoningProfile } from "../instances/reasoning-profile.js";
import { getExternalApiEndpoint } from "./endpoints.js";
import type {
  ApiProxyProtocolId,
  ApiProxyProtocolOperation,
} from "./protocol.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";
import { prepareUpstreamExchange } from "./translation.js";

function endpointReasoningProfile(
  endpointId: string,
): ApiProxyUpstreamReasoningProfile | null {
  const endpoint = getExternalApiEndpoint(endpointId);
  const profile = resolveApiProxyReasoningProfile(endpoint?.reasoning ?? null);
  return profile ? { profile, source: "endpoint override" } : null;
}

export function resolveApiProxyUpstreamReasoningProfile(input: {
  instanceId: string | null;
  endpointId: string | null;
}): ApiProxyUpstreamReasoningProfile | null {
  if (input.instanceId) {
    return instanceReasoningProfile(input.instanceId);
  }
  return input.endpointId ? endpointReasoningProfile(input.endpointId) : null;
}

export type ApiProxyMappedReasoningBody = {
  body: unknown;
  traceStep: ApiProxyRouteTraceStep | null;
};

export type ApiProxyUpstreamRequest = {
  protocol: ApiProxyProtocolId;
  path: string;
  headers: Headers;
  body: unknown;
  warnings: string[];
  traceStep: ApiProxyRouteTraceStep | null;
};

export function prepareApiProxyUpstreamRequest(input: {
  translate: boolean;
  translationDialect: EngineTranslationDialectId;
  operation: ApiProxyProtocolOperation;
  path: string;
  body: unknown;
  headers: Headers;
  instanceId: string | null;
  endpointId: string | null;
  trace?: ProxyTraceAccumulator;
}): ApiProxyUpstreamRequest {
  const exchange = prepareUpstreamExchange({
    translate: input.translate,
    translationDialect: input.translationDialect,
    operation: input.operation,
    path: input.path,
    body: input.body,
    headers: input.headers,
  });
  const reasoning = applyApiProxyReasoningMapping({
    body: exchange.body,
    protocol: exchange.protocol,
    instanceId: input.instanceId,
    endpointId: input.endpointId,
  });
  if (input.trace) {
    if (exchange.warnings.length > 0) {
      input.trace.translationWarnings = exchange.warnings;
    }
    if (reasoning.traceStep) {
      input.trace.routeTrace = [...input.trace.routeTrace, reasoning.traceStep];
    }
  }
  return {
    protocol: exchange.protocol,
    path: exchange.path,
    headers: exchange.headers,
    body: reasoning.body,
    warnings: exchange.warnings,
    traceStep: reasoning.traceStep,
  };
}

export function applyApiProxyReasoningMapping(input: {
  body: unknown;
  protocol: "openai" | "anthropic";
  instanceId: string | null;
  endpointId: string | null;
}): ApiProxyMappedReasoningBody {
  const resolved = resolveApiProxyUpstreamReasoningProfile(input);
  if (!resolved || resolved.profile.interface === "passthrough") {
    return { body: input.body, traceStep: null };
  }
  const extraction = extractApiProxyReasoningDirective(
    input.protocol,
    input.body,
  );
  if (extraction.directive === null && !resolved.profile.defaultLevel) {
    return { body: input.body, traceStep: null };
  }
  const stripped = stripApiProxyReasoningFields(input.protocol, input.body);
  const materialization = apiProxyReasoningDirectiveOperations(
    extraction.directive,
    resolved.profile,
    input.protocol,
  );
  const edited = applyApiProxyRequestEdits(
    stripped,
    materialization.operations,
  );
  return {
    body: edited.body,
    traceStep: {
      kind: "reasoning",
      pipelineId: null,
      pipelineName: null,
      nodeId: null,
      nodeName: `reasoning profile (${resolved.source})`,
      port: null,
      detail: `${apiProxyReasoningExtractionDetail(extraction)} → ${materialization.detail}`,
    },
  };
}
