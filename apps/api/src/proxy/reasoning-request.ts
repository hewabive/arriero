import {
  apiProxyReasoningDirectiveOperations,
  apiProxyReasoningExtractionDetail,
  applyApiProxyRequestEdits,
  engineDescriptor,
  extractApiProxyReasoningDirective,
  normalizeApiProxyReasoningLevel,
  resolveApiProxyReasoningProfile,
  stripApiProxyReasoningFields,
  API_PROXY_REASONING_LEVELS,
  type ApiProxyModelRecord,
  type ApiProxyReasoningLevel,
  type ApiProxyReasoningProfile,
  type ApiProxyRouteTraceStep,
  type GgufChatTemplateReasoning,
  type MemoryEstimateArgs,
} from "@arriero/core";

import { getInstance } from "../instances/repository.js";
import { resolveModelPath } from "../memory-estimate/service.js";
import { getCachedModelEntry } from "../models/cache-repository.js";

const llamaBudgetProfile: ApiProxyReasoningProfile = {
  interface: "budget",
  levels: [],
  aliases: {},
  defaultLevel: null,
  levelBudgets: {},
};

function levelRank(level: ApiProxyReasoningLevel): number {
  return API_PROXY_REASONING_LEVELS.indexOf(level);
}

export function reasoningProfileFromTemplate(
  detection: GgufChatTemplateReasoning,
): ApiProxyReasoningProfile {
  const levels = [
    ...new Set(
      (detection.levels ?? [])
        .map((level) => normalizeApiProxyReasoningLevel(level))
        .filter((level): level is ApiProxyReasoningLevel => level !== null),
    ),
  ].sort((left, right) => levelRank(left) - levelRank(right));
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
    levels: levels.length >= 2 ? levels : [],
    aliases,
    defaultLevel: null,
    levelBudgets: {},
  };
}

export type ApiProxyUpstreamReasoningProfile = {
  profile: ApiProxyReasoningProfile;
  source: string;
};

export function resolveApiProxyUpstreamReasoningProfile(input: {
  model: ApiProxyModelRecord;
  instanceId: string | null;
}): ApiProxyUpstreamReasoningProfile | null {
  const override = resolveApiProxyReasoningProfile(input.model.reasoning);
  if (override) {
    return { profile: override, source: "model override" };
  }
  if (!input.instanceId) {
    return null;
  }
  const instance = getInstance(input.instanceId);
  if (!instance || engineDescriptor(instance.kind).nativeApi !== "llama") {
    return null;
  }
  const modelPath = resolveModelPath(instance.args as MemoryEstimateArgs);
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

export type ApiProxyMappedReasoningBody = {
  body: unknown;
  traceStep: ApiProxyRouteTraceStep | null;
};

export function applyApiProxyReasoningMapping(input: {
  body: unknown;
  protocol: "openai" | "anthropic";
  model: ApiProxyModelRecord;
  instanceId: string | null;
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
