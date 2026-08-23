import {
  apiProxyReasoningDirectiveOperations,
  apiProxyReasoningExtractionDetail,
  apiProxyReasoningLevelRank,
  applyApiProxyRequestEdits,
  engineDescriptor,
  extractApiProxyReasoningDirective,
  normalizeApiProxyReasoningLevel,
  resolveApiProxyReasoningProfile,
  stripApiProxyReasoningFields,
  type ApiProxyReasoningLevel,
  type ApiProxyReasoningProfile,
  type ApiProxyRouteTraceStep,
  type ApiProxyUpstreamReasoningProfile,
  type GgufChatTemplateReasoning,
  type MemoryEstimateArgs,
  type ReasoningTemplateIssue,
} from "@arriero/core";

import { getInstanceRecord } from "../instances/config-files.js";
import { resolveModelPath } from "../memory-estimate/service.js";
import { getCachedModelEntry } from "../models/cache-repository.js";
import { getExternalApiEndpoint } from "./endpoints.js";
import type {
  ApiProxyProtocolId,
  ApiProxyProtocolOperation,
} from "./protocol.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";
import { prepareUpstreamExchange } from "./translation.js";

const llamaBudgetProfile: ApiProxyReasoningProfile = {
  interface: "budget",
  strict: true,
  levels: [],
  aliases: {},
  defaultLevel: null,
  levelBudgets: {},
};

export function reasoningProfileFromTemplate(
  detection: GgufChatTemplateReasoning,
): ApiProxyReasoningProfile {
  const levels = [
    ...new Set(
      (detection.levels ?? [])
        .map((level) => normalizeApiProxyReasoningLevel(level))
        .filter((level): level is ApiProxyReasoningLevel => level !== null),
    ),
  ].sort(
    (left, right) =>
      apiProxyReasoningLevelRank(left) - apiProxyReasoningLevelRank(right),
  );
  const aliases: Partial<
    Record<ApiProxyReasoningLevel, ApiProxyReasoningLevel>
  > = {};
  for (const [from, to] of Object.entries(detection.aliases ?? {})) {
    const fromLevel = normalizeApiProxyReasoningLevel(from);
    const toLevel = normalizeApiProxyReasoningLevel(to);
    if (fromLevel && toLevel && fromLevel !== toLevel) {
      aliases[fromLevel] = toLevel;
    }
  }
  return {
    interface: "template-effort",
    strict: detection.strict,
    levels: levels.length >= 2 ? levels : [],
    aliases,
    defaultLevel: null,
    levelBudgets: {},
  };
}

const INSTANCE_PROFILE_TTL_MS = 2000;

const instanceProfileCache = new Map<
  string,
  { at: number; value: ApiProxyUpstreamReasoningProfile | null }
>();

function computeInstanceReasoningProfile(
  instanceId: string,
): ApiProxyUpstreamReasoningProfile | null {
  const record = getInstanceRecord(instanceId);
  if (!record) {
    return null;
  }
  const override = resolveApiProxyReasoningProfile(record.reasoning ?? null);
  if (override) {
    return { profile: override, source: "instance override" };
  }
  if (engineDescriptor(record.kind).nativeApi !== "llama") {
    return null;
  }
  const modelPath = resolveModelPath(record.args as MemoryEstimateArgs);
  const detection = modelPath
    ? (getCachedModelEntry(modelPath)?.model?.metadata.chatTemplateReasoning ??
      null)
    : null;
  if (detection?.usesReasoningEffort) {
    return {
      profile: reasoningProfileFromTemplate(detection),
      source: "template",
    };
  }
  return { profile: llamaBudgetProfile, source: "engine default" };
}

export function instanceReasoningProfile(
  instanceId: string,
): ApiProxyUpstreamReasoningProfile | null {
  const cached = instanceProfileCache.get(instanceId);
  if (cached && Date.now() - cached.at < INSTANCE_PROFILE_TTL_MS) {
    return cached.value;
  }
  const value = computeInstanceReasoningProfile(instanceId);
  instanceProfileCache.set(instanceId, { at: Date.now(), value });
  return value;
}

export function instanceReasoningTemplateIssue(
  instanceId: string,
): ReasoningTemplateIssue | null {
  const resolved = instanceReasoningProfile(instanceId);
  if (
    !resolved ||
    resolved.source !== "template" ||
    resolved.profile.interface !== "template-effort" ||
    resolved.profile.levels.length > 0
  ) {
    return null;
  }
  return { strict: resolved.profile.strict };
}

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
