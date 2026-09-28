import { createHash } from "node:crypto";

import {
  PIPELINE_NODE_TYPES,
  WorkloadReplayableOutcomeSchema,
  apiProxyClientAbortErrorCode,
  pipelineNodeDescriptor,
  type ApiProxyPipelineNodeType,
  type ApiProxyRequestTrace,
  type ApiProxyTraceFile,
  type WorkloadOutcome,
  type WorkloadRecord,
  type WorkloadRecordIssue,
  type WorkloadReplayableOutcome,
} from "@arriero/core";

import { sanitizeClaudeCodeAttribution } from "../proxy/attribution.js";
import { asObject, isRecord } from "../proxy/json.js";
import {
  CAPTURE_REQUEST_FILE_KIND,
  isSavedCaptureStep,
} from "../proxy/pipeline.js";
import type {
  ApiProxyAuthDiagnosticCode,
  ApiProxyProtocolDiagnosticCode,
} from "../proxy/protocol.js";
import { safeJsonParse } from "../proxy/protocol-trace.js";

export const WORKLOAD_NORMALIZATION_VERSION = 1;

export const WORKLOAD_REPLAYABLE_ENDPOINTS: Record<
  "openai" | "anthropic",
  string
> = {
  openai: "chat.completions",
  anthropic: "messages",
};

const replayableOutcomes: ReadonlySet<WorkloadOutcome> = new Set(
  WorkloadReplayableOutcomeSchema.options,
);

export type ReplayableWorkloadRecord = WorkloadRecord & {
  issue: null;
  outcome: WorkloadReplayableOutcome;
};

export function isServedWorkloadOutcome(
  outcome: WorkloadOutcome,
): outcome is WorkloadReplayableOutcome {
  return replayableOutcomes.has(outcome);
}

export function isReplayableWorkloadRecord(
  record: WorkloadRecord,
): record is ReplayableWorkloadRecord {
  return record.issue === null && isServedWorkloadOutcome(record.outcome);
}

const errorCodeOutcomes: Record<
  ApiProxyProtocolDiagnosticCode | ApiProxyAuthDiagnosticCode,
  "not-served" | "error"
> = {
  arriero_proxy_model_unbound: "not-served",
  arriero_proxy_model_disabled: "not-served",
  arriero_proxy_target_not_found: "not-served",
  arriero_proxy_pipeline_not_found: "not-served",
  arriero_proxy_pipeline_disabled: "not-served",
  arriero_proxy_pipeline_cycle: "not-served",
  arriero_proxy_route_unbound: "not-served",
  arriero_proxy_route_invalid: "not-served",
  arriero_proxy_context_overflow: "not-served",
  arriero_proxy_token_count_unavailable: "not-served",
  arriero_proxy_source_required: "not-served",
  arriero_proxy_source_disabled: "not-served",
  invalid_api_key: "not-served",
  arriero_proxy_instance_reserved: "not-served",
  arriero_proxy_plan_blocked: "error",
  arriero_proxy_target_not_ready: "error",
  arriero_proxy_action_unsupported: "error",
  arriero_proxy_instance_not_found: "error",
  arriero_proxy_instance_start_failed: "error",
  arriero_proxy_upstream_unavailable: "error",
  arriero_proxy_upstream_timeout: "error",
  arriero_proxy_upstream_error: "error",
};

function isKnownErrorCode(
  code: string,
): code is keyof typeof errorCodeOutcomes {
  return Object.hasOwn(errorCodeOutcomes, code);
}

export function classifyWorkloadOutcome(
  trace: ApiProxyRequestTrace,
): WorkloadOutcome {
  if (trace.cache === "hit" || trace.cache === "coalesced") {
    return "not-served";
  }
  if (trace.errorCode === apiProxyClientAbortErrorCode) {
    return "client-abort";
  }
  if (trace.errorCode !== null) {
    return isKnownErrorCode(trace.errorCode)
      ? errorCodeOutcomes[trace.errorCode]
      : "error";
  }
  if (trace.status < 200 || trace.status >= 300) {
    return "error";
  }
  return trace.streamHealth?.truncated === true ? "error" : "success";
}

export function workloadCaptureFile(
  trace: ApiProxyRequestTrace,
): ApiProxyTraceFile | null {
  const captures = trace.files.filter(
    (file) => file.kind === CAPTURE_REQUEST_FILE_KIND,
  );
  return captures.at(-1) ?? null;
}

function isPipelineNodeType(kind: string): kind is ApiProxyPipelineNodeType {
  return (PIPELINE_NODE_TYPES as readonly string[]).includes(kind);
}

function rewritesAfterLastCapture(trace: ApiProxyRequestTrace): boolean {
  const steps = trace.routeTrace;
  let lastCapture = -1;
  steps.forEach((step, index) => {
    if (isSavedCaptureStep(step)) {
      lastCapture = index;
    }
  });
  return steps
    .slice(lastCapture + 1)
    .some(
      (step) =>
        step.nodeId !== null &&
        isPipelineNodeType(step.kind) &&
        pipelineNodeDescriptor(step.kind).rewritesRequest,
    );
}

function involvesFusion(trace: ApiProxyRequestTrace): boolean {
  return trace.routeTrace.some(
    (step) => step.kind === "fusion" || step.kind === "fusion-branch",
  );
}

export function workloadRecordIssue(input: {
  trace: ApiProxyRequestTrace;
  protocol: "openai" | "anthropic";
  endpoint: string;
  body: unknown;
}): WorkloadRecordIssue | null {
  if (input.endpoint === "responses") {
    const previous = asObject(input.body)?.previous_response_id;
    return typeof previous === "string" && previous.length > 0
      ? "stateful-request"
      : "unsupported-operation";
  }
  if (
    WORKLOAD_REPLAYABLE_ENDPOINTS[input.protocol] !== input.endpoint ||
    involvesFusion(input.trace)
  ) {
    return "unsupported-operation";
  }
  if (!Array.isArray(asObject(input.body)?.messages)) {
    return "body-not-object";
  }
  return rewritesAfterLastCapture(input.trace) ? "capture-after-rewrite" : null;
}

function linkingForm(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(linkingForm);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key !== "cache_control") {
      out[key] = linkingForm(value[key]);
    }
  }
  return out;
}

function digest(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function normalizedJson(value: unknown): string {
  return JSON.stringify(linkingForm(value) ?? null);
}

export type WorkloadChatBodyParts = {
  messages: unknown[];
  tools: unknown;
  system: unknown;
  fields: Record<string, unknown>;
};

export function splitWorkloadChatBody(
  protocol: "openai" | "anthropic",
  body: unknown,
): WorkloadChatBodyParts | null {
  const record = asObject(body);
  const messages = record?.messages;
  if (!record || !Array.isArray(messages)) {
    return null;
  }
  const separateSystem = protocol === "anthropic";
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "messages" ||
      key === "tools" ||
      (separateSystem && key === "system")
    ) {
      continue;
    }
    fields[key] = value;
  }
  return {
    messages,
    tools: record.tools,
    system: separateSystem ? record.system : undefined,
    fields,
  };
}

export type WorkloadChain = {
  messageCount: number;
  chain: string[];
  key: string;
};

export function workloadChain(
  protocol: "openai" | "anthropic",
  body: unknown,
): WorkloadChain | null {
  const parts = splitWorkloadChatBody(
    protocol,
    sanitizeClaudeCodeAttribution(body),
  );
  if (!parts) {
    return null;
  }
  const root = {
    tools: parts.tools ?? null,
    system: parts.system ?? null,
  };
  let current = digest(["root", normalizedJson(root)]);
  const chain: string[] = [];
  for (const message of parts.messages) {
    current = digest([current, normalizedJson(message)]);
    chain.push(current);
  }
  return { messageCount: parts.messages.length, chain, key: current };
}

const claudeCodeSessionPattern = /_session_([0-9a-f][0-9a-f-]{7,})/i;

export function workloadClientSessionId(body: unknown): string | null {
  const record = asObject(body);
  const promptCacheKey = record?.prompt_cache_key;
  if (typeof promptCacheKey === "string" && promptCacheKey.length > 0) {
    return promptCacheKey;
  }
  const userId = asObject(record?.metadata)?.user_id;
  if (typeof userId !== "string") {
    return null;
  }
  const legacy = claudeCodeSessionPattern.exec(userId)?.[1];
  if (legacy) {
    return legacy;
  }
  const sessionId = asObject(safeJsonParse(userId))?.session_id;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : null;
}

export type WorkloadCacheMetrics = {
  cacheLossTokens: number | null;
  responseReuseTokens: number | null;
};

export function workloadCacheMetrics(
  parent: { targetId: string | null; promptTokens: number | null },
  child: { targetId: string | null; cacheReadTokens: number | null },
): WorkloadCacheMetrics {
  if (
    parent.targetId === null ||
    parent.targetId !== child.targetId ||
    parent.promptTokens === null ||
    child.cacheReadTokens === null
  ) {
    return { cacheLossTokens: null, responseReuseTokens: null };
  }
  return {
    cacheLossTokens: Math.max(0, parent.promptTokens - child.cacheReadTokens),
    responseReuseTokens: Math.max(
      0,
      child.cacheReadTokens - parent.promptTokens,
    ),
  };
}

export function workloadThinkTimeMs(
  previous: { endAt: string } | null,
  at: string,
): number | null {
  if (!previous) {
    return null;
  }
  const previousEnd = Date.parse(previous.endAt);
  const start = Date.parse(at);
  if (!Number.isFinite(previousEnd) || !Number.isFinite(start)) {
    return null;
  }
  return Math.max(0, Math.round(start - previousEnd));
}
