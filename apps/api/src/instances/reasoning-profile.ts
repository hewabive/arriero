import {
  apiProxyReasoningLevelRank,
  engineDescriptor,
  normalizeApiProxyReasoningLevel,
  resolveApiProxyReasoningProfile,
  type ApiProxyReasoningLevel,
  type ApiProxyReasoningProfile,
  type ApiProxyUpstreamReasoningProfile,
  type GgufChatTemplateReasoning,
  type MemoryEstimateArgs,
  type ReasoningTemplateIssue,
} from "@arriero/core";

import { resolveModelPath } from "../memory-estimate/service.js";
import { getCachedModelEntry } from "../models/cache-repository.js";
import { getInstanceRecord } from "./config-files.js";

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
  return resolved.profile.strict ? "strict" : "tolerant";
}
