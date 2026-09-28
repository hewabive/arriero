import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PIPELINE_NODE_TYPES,
  pipelineNodeDescriptor,
  type ApiProxyRequestTrace,
  type ApiProxyRouteTraceStep,
} from "@arriero/core";

import {
  classifyWorkloadOutcome,
  workloadCacheMetrics,
  workloadCaptureFile,
  workloadChain,
  workloadClientSessionId,
  workloadRecordIssue,
  workloadThinkTimeMs,
} from "./record-analysis.js";

function trace(over: Partial<ApiProxyRequestTrace> = {}): ApiProxyRequestTrace {
  return {
    id: "t1",
    at: "2026-09-20T10:00:00.000Z",
    protocol: "openai",
    translated: false,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "m1",
    sourceId: null,
    sourceName: null,
    stream: true,
    targetId: "target-a",
    targetName: "a",
    slotId: null,
    cacheOrigin: null,
    cache: null,
    resumed: false,
    textReplacementCount: 0,
    routeTrace: [],
    files: [],
    schedulerActions: [],
    displacedTargetIds: [],
    usage: null,
    streamHealth: null,
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    translationWarnings: [],
    durationMs: 1000,
    queueMs: null,
    ttftMs: null,
    ...over,
  };
}

function step(
  kind: ApiProxyRouteTraceStep["kind"],
  over: Partial<ApiProxyRouteTraceStep> = {},
): ApiProxyRouteTraceStep {
  return {
    kind,
    pipelineId: "p1",
    pipelineName: "pipeline",
    nodeId: `${kind}-node`,
    nodeName: null,
    port: "next",
    detail: null,
    ...over,
  };
}

const savedCapture = step("capture-request", { detail: "request saved" });

test("only request-rewriting node types carry the rewriting fact", () => {
  assert.deepEqual(
    PIPELINE_NODE_TYPES.filter(
      (type) => pipelineNodeDescriptor(type).rewritesRequest,
    ),
    [
      "replace-text",
      "edit-request",
      "reasoning",
      "output-limit",
      "token-scale",
      "strip-attribution",
    ],
  );
});

test("classifies served, aborted, unserved and failed requests", () => {
  assert.equal(classifyWorkloadOutcome(trace()), "success");
  assert.equal(
    classifyWorkloadOutcome(trace({ status: 499, errorCode: "client-abort" })),
    "client-abort",
  );
  assert.equal(classifyWorkloadOutcome(trace({ cache: "hit" })), "not-served");
  assert.equal(
    classifyWorkloadOutcome(trace({ cache: "coalesced" })),
    "not-served",
  );
  assert.equal(
    classifyWorkloadOutcome(
      trace({ status: 400, errorCode: "arriero_proxy_context_overflow" }),
    ),
    "not-served",
  );
  assert.equal(
    classifyWorkloadOutcome(
      trace({ status: 423, errorCode: "invalid_api_key" }),
    ),
    "not-served",
  );
  assert.equal(
    classifyWorkloadOutcome(
      trace({ status: 503, errorCode: "arriero_proxy_target_not_ready" }),
    ),
    "error",
  );
  assert.equal(
    classifyWorkloadOutcome(
      trace({ status: 502, errorCode: "arriero_proxy_upstream_error" }),
    ),
    "error",
  );
  assert.equal(classifyWorkloadOutcome(trace({ status: 500 })), "error");
  assert.equal(
    classifyWorkloadOutcome(trace({ status: 400, errorCode: "unknown-code" })),
    "error",
  );
  assert.equal(
    classifyWorkloadOutcome(
      trace({
        streamHealth: {
          malformedChunks: 0,
          terminal: "eof",
          truncated: true,
          truncationRetries: 0,
        },
      }),
    ),
    "error",
  );
});

test("picks the last request capture of a trace", () => {
  const file = (name: string, kind: string) => ({
    name,
    path: `m1/dir/${name}`,
    kind,
    label: null,
    bytes: 1,
    createdAt: "2026-09-20T10:00:00.000Z",
  });
  const chosen = workloadCaptureFile(
    trace({
      files: [
        file("01-capture-request.json", "capture-request"),
        file("02-capture-request.json", "capture-request"),
        file("03-capture-response.json", "capture-response"),
      ],
    }),
  );
  assert.equal(chosen?.name, "02-capture-request.json");
  assert.equal(workloadCaptureFile(trace()), null);
});

const chatBody = { messages: [{ role: "user", content: "hi" }] };

test("accepts a capture followed only by body-neutral steps", () => {
  const issue = (routeTrace: ApiProxyRouteTraceStep[]) =>
    workloadRecordIssue({
      trace: trace({ routeTrace }),
      protocol: "openai",
      endpoint: "chat.completions",
      body: chatBody,
    });
  assert.equal(issue([step("strip-attribution"), savedCapture]), null);
  assert.equal(
    issue([savedCapture, step("condition"), step("cache"), step("loop-guard")]),
    null,
  );
  assert.equal(
    issue([
      savedCapture,
      step("reasoning", { nodeId: null, pipelineId: null }),
    ]),
    null,
  );
});

test("rejects a capture followed by a rewriting node", () => {
  const issue = (routeTrace: ApiProxyRouteTraceStep[]) =>
    workloadRecordIssue({
      trace: trace({ routeTrace }),
      protocol: "openai",
      endpoint: "chat.completions",
      body: chatBody,
    });
  assert.equal(
    issue([savedCapture, step("edit-request")]),
    "capture-after-rewrite",
  );
  assert.equal(
    issue([
      savedCapture,
      step("output-limit"),
      step("capture-request", { detail: "response at completion" }),
    ]),
    "capture-after-rewrite",
  );
});

test("flags operations and bodies the replay cannot use", () => {
  assert.equal(
    workloadRecordIssue({
      trace: trace(),
      protocol: "openai",
      endpoint: "responses",
      body: { input: "hi", previous_response_id: "resp_1" },
    }),
    "stateful-request",
  );
  assert.equal(
    workloadRecordIssue({
      trace: trace(),
      protocol: "openai",
      endpoint: "responses",
      body: { input: "hi" },
    }),
    "unsupported-operation",
  );
  assert.equal(
    workloadRecordIssue({
      trace: trace(),
      protocol: "openai",
      endpoint: "embeddings",
      body: { input: "hi" },
    }),
    "unsupported-operation",
  );
  assert.equal(
    workloadRecordIssue({
      trace: trace({ routeTrace: [step("fusion")] }),
      protocol: "openai",
      endpoint: "chat.completions",
      body: chatBody,
    }),
    "unsupported-operation",
  );
  assert.equal(
    workloadRecordIssue({
      trace: trace(),
      protocol: "anthropic",
      endpoint: "messages",
      body: { prompt: "hi" },
    }),
    "body-not-object",
  );
  assert.equal(
    workloadRecordIssue({
      trace: trace(),
      protocol: "anthropic",
      endpoint: "messages",
      body: chatBody,
    }),
    null,
  );
});

test("a continuing request extends its parent's chain", () => {
  const tools = [{ type: "function", function: { name: "read" } }];
  const parent = workloadChain("openai", {
    model: "m",
    tools,
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
    ],
  });
  const child = workloadChain("openai", {
    model: "m",
    stream: true,
    tools,
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "tool", content: "r1", tool_call_id: "c1" },
    ],
  });
  assert.ok(parent && child);
  assert.equal(child.messageCount, 4);
  assert.equal(child.chain[1], parent.key);
  const otherTools = workloadChain("openai", {
    tools: [{ type: "function", function: { name: "write" } }],
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
    ],
  });
  assert.notEqual(otherTools?.key, parent.key);
  assert.equal(workloadChain("openai", { input: "x" }), null);
});

test("moving cache_control markers and attribution churn do not break a chain", () => {
  const system = (hash: string) => [
    {
      type: "text",
      text: `x-anthropic-billing-header: cc_version=2.1.40; cc_entrypoint=cli; cch=${hash};`,
    },
    { type: "text", text: "You are a coding agent." },
  ];
  const parent = workloadChain("anthropic", {
    system: system("aaaa1111"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "u1", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  });
  const child = workloadChain("anthropic", {
    system: system("bbbb2222"),
    messages: [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "u2", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  });
  assert.ok(parent && child);
  assert.equal(child.chain[0], parent.key);
  const otherSystem = workloadChain("anthropic", {
    system: "another agent",
    messages: [{ role: "user", content: [{ type: "text", text: "u1" }] }],
  });
  assert.notEqual(otherSystem?.key, parent.key);
});

test("reads client session identifiers where a client sends one", () => {
  assert.equal(
    workloadClientSessionId({
      metadata: {
        user_id:
          "user_0f3a_account_6b1f5c2e-0000-4000-8000-000000000001_session_123e4567-e89b-12d3-a456-426614174000",
      },
    }),
    "123e4567-e89b-12d3-a456-426614174000",
  );
  assert.equal(
    workloadClientSessionId({
      metadata: {
        user_id: JSON.stringify({ device_id: "d", session_id: "s-42" }),
      },
    }),
    "s-42",
  );
  assert.equal(
    workloadClientSessionId({ prompt_cache_key: "conversation-7" }),
    "conversation-7",
  );
  assert.equal(workloadClientSessionId({ metadata: { user_id: "u" } }), null);
  assert.equal(workloadClientSessionId({ messages: [] }), null);
});

test("cache metrics compare a child with a same-target parent only", () => {
  assert.deepEqual(
    workloadCacheMetrics(
      { targetId: "a", promptTokens: 40_000 },
      { targetId: "a", cacheReadTokens: 12_000 },
    ),
    { cacheLossTokens: 28_000, responseReuseTokens: 0 },
  );
  assert.deepEqual(
    workloadCacheMetrics(
      { targetId: "a", promptTokens: 40_000 },
      { targetId: "a", cacheReadTokens: 40_500 },
    ),
    { cacheLossTokens: 0, responseReuseTokens: 500 },
  );
  assert.deepEqual(
    workloadCacheMetrics(
      { targetId: "a", promptTokens: 40_000 },
      { targetId: "b", cacheReadTokens: 0 },
    ),
    { cacheLossTokens: null, responseReuseTokens: null },
  );
  assert.deepEqual(
    workloadCacheMetrics(
      { targetId: "a", promptTokens: 40_000 },
      { targetId: "a", cacheReadTokens: null },
    ),
    { cacheLossTokens: null, responseReuseTokens: null },
  );
});

test("think time runs from the previous answer's end, never negative", () => {
  assert.equal(
    workloadThinkTimeMs(
      { endAt: "2026-09-20T10:00:02.000Z" },
      "2026-09-20T10:00:05.000Z",
    ),
    3000,
  );
  assert.equal(
    workloadThinkTimeMs(
      { endAt: "2026-09-20T10:00:09.000Z" },
      "2026-09-20T10:00:05.000Z",
    ),
    0,
  );
  assert.equal(workloadThinkTimeMs(null, "2026-09-20T10:00:05.000Z"), null);
});
