import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiProxyModelRecordSchema,
  ApiProxyTargetRecordSchema,
  type FleetNode,
} from "@arriero/core";

import { anthropicProtocolAdapter } from "./anthropic.js";
import { openAiProtocolAdapter } from "./openai.js";
import {
  delegateServeRequestBody,
  delegationErrorDiagnostic,
} from "./protocol-endpoint.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolOperation,
} from "./protocol.js";

function operation(
  protocol: "openai" | "anthropic",
  endpoint: string,
): ApiProxyProtocolOperation {
  return {
    protocol,
    endpoint,
    routePath: `/${protocol}/${endpoint}`,
    transport: "http-json",
  };
}

function modelRequest(input: {
  protocol: "openai" | "anthropic";
  endpoint: string;
  stream: boolean;
  body: unknown;
}): ApiProxyProtocolModelRequest {
  return {
    operation: operation(input.protocol, input.endpoint),
    body: input.body,
    modelId: "qwen",
    model: ApiProxyModelRecordSchema.parse({
      id: "m1",
      modelId: "qwen",
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
    }),
    stream: input.stream,
  };
}

function adapterFor(protocol: "openai" | "anthropic"): ApiProxyProtocolAdapter {
  return protocol === "anthropic"
    ? anthropicProtocolAdapter
    : openAiProtocolAdapter;
}

function shape(
  protocol: "openai" | "anthropic",
  endpoint: string,
  stream: boolean,
) {
  const request = modelRequest({
    protocol,
    endpoint,
    stream,
    body: { model: "qwen" },
  });
  return delegateServeRequestBody(
    request,
    request.operation,
    adapterFor(protocol),
  ) as Record<string, unknown>;
}

test("delegated openai chat stream requests usage and prefill from the peer", () => {
  const body = shape("openai", "chat.completions", true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.return_progress, true);
});

test("delegated anthropic messages stream requests prefill but not openai usage", () => {
  const body = shape("anthropic", "messages", true);
  assert.equal(body.return_progress, true);
  assert.equal("stream_options" in body, false);
});

test("delegated non-stream request is forwarded verbatim", () => {
  const request = modelRequest({
    protocol: "openai",
    endpoint: "chat.completions",
    stream: false,
    body: { model: "qwen", messages: [] },
  });
  const body = delegateServeRequestBody(
    request,
    request.operation,
    openAiProtocolAdapter,
  );
  assert.deepEqual(body, { model: "qwen", messages: [] });
});

test("delegated non-resumable stream is not augmented with prefill", () => {
  const body = shape("openai", "completions", true);
  assert.equal("return_progress" in body, false);
});

const diagTarget = ApiProxyTargetRecordSchema.parse({
  id: "target-a",
  name: "Target A",
  endpointId: "remote:ny:remote-a",
  model: "qwen",
  role: "interactive",
  priority: 100,
  preemptible: true,
  saveSlotsBeforeUnload: false,
  slotIds: [],
  idleUnloadMs: null,
});

const diagNode: FleetNode = {
  id: "ny",
  name: "NY",
  baseUrl: "http://ny.local:8787",
  enabled: true,
};

test("delegationErrorDiagnostic maps a headers timeout to a 504", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    }),
  });
  const diagnostic = delegationErrorDiagnostic(diagTarget, diagNode, error);
  assert.equal(diagnostic.status, 504);
  assert.equal(diagnostic.code, "arriero_proxy_upstream_timeout");
  assert.match(diagnostic.message, /NY/);
});

test("delegationErrorDiagnostic maps a refused connection to a 503", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const diagnostic = delegationErrorDiagnostic(diagTarget, diagNode, error);
  assert.equal(diagnostic.status, 503);
  assert.equal(diagnostic.code, "arriero_proxy_upstream_unavailable");
});

test("delegationErrorDiagnostic falls back to a 502 for unknown errors", () => {
  const diagnostic = delegationErrorDiagnostic(
    diagTarget,
    diagNode,
    new Error("weird"),
  );
  assert.equal(diagnostic.status, 502);
  assert.equal(diagnostic.code, "arriero_proxy_upstream_error");
});
