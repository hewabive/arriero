import { createHash } from "node:crypto";

import {
  PIPELINE_NODE_TYPES,
  apiProxyClientAbortErrorCode,
  pipelineNodeDescriptor,
  type ApiProxyPipelineNodeType,
  type ApiProxyRequestTrace,
  type ApiProxyTraceFile,
  type WorkloadOutcome,
  type WorkloadRecordIssue,
} from "@arriero/core";

import { sanitizeClaudeCodeAttribution } from "../proxy/attribution.js";
import { asObject } from "../proxy/json.js";
import { CAPTURE_REQUEST_SAVED_DETAIL } from "../proxy/pipeline.js";
import type {
  ApiProxyAuthDiagnosticCode,
  ApiProxyProtocolDiagnosticCode,
} from "../proxy/protocol.js";
import { safeJsonParse } from "../proxy/protocol-trace.js";
import { canonicalize } from "../utils/canonical-json.js";

export const WORKLOAD_NORMALIZATION_VERSION = 1;

export const WORKLOAD_CAPTURE_FILE_KIND = "capture-request";

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
    (file) => file.kind === WORKLOAD_CAPTURE_FILE_KIND,
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
    if (
      step.kind === WORKLOAD_CAPTURE_FILE_KIND &&
      step.detail?.includes(CAPTURE_REQUEST_SAVED_DETAIL) === true
    ) {
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

const replayableEndpoints: Record<"openai" | "anthropic", string> = {
  openai: "chat.completions",
  anthropic: "messages",
};

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
    replayableEndpoints[input.protocol] !== input.endpoint ||
    involvesFusion(input.trace)
  ) {
    return "unsupported-operation";
  }
  if (!Array.isArray(asObject(input.body)?.messages)) {
    return "body-not-object";
  }
  return rewritesAfterLastCapture(input.trace) ? "capture-after-rewrite" : null;
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheControl);
  }
  const record = asObject(value);
  if (!record) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key !== "cache_control") {
      out[key] = withoutCacheControl(entry);
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
  return JSON.stringify(canonicalize(withoutCacheControl(value)) ?? null);
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
  const record = asObject(sanitizeClaudeCodeAttribution(body));
  const messages = record?.messages;
  if (!record || !Array.isArray(messages)) {
    return null;
  }
  const root = {
    tools: record.tools ?? null,
    system: protocol === "anthropic" ? (record.system ?? null) : null,
  };
  let current = digest(["root", normalizedJson(root)]);
  const chain: string[] = [];
  for (const message of messages) {
    current = digest([current, normalizedJson(message)]);
    chain.push(current);
  }
  return { messageCount: messages.length, chain, key: current };
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
  previous: { at: string; durationMs: number } | null,
  at: string,
): number | null {
  if (!previous) {
    return null;
  }
  const previousEnd = Date.parse(previous.at) + previous.durationMs;
  const start = Date.parse(at);
  if (!Number.isFinite(previousEnd) || !Number.isFinite(start)) {
    return null;
  }
  return Math.max(0, Math.round(start - previousEnd));
}
