import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiProxyModelRecord,
  ApiProxyPlanPreview,
  ApiProxyTargetRecord,
} from "@arriero/core";

import { buildApiProxyProtocolGatewayResponse } from "./gateway.js";
import { openAiProtocolAdapter } from "./openai.js";
import type { ApiProxyProtocolModelRequest } from "./protocol.js";

const target: ApiProxyTargetRecord = {
  id: "target-a",
  name: "Interactive",
  endpointId: "instance:instance-a",
  model: "qwen",
  role: "interactive",
  priority: 100,
  preemptible: true,
  saveSlotsBeforeUnload: false,
  slotIds: [],
  idleUnloadMs: null,
  createdAt: "2026-05-30T10:00:00.000Z",
  updatedAt: "2026-05-30T10:00:00.000Z",
};

function model(update: Partial<ApiProxyModelRecord> = {}): ApiProxyModelRecord {
  return {
    id: "model-a",
    modelId: "qwen-public",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: target.id,
    routeTo: null,
    description: null,
    createdAt: "2026-05-30T10:00:00.000Z",
    updatedAt: "2026-05-30T10:00:00.000Z",
    ...update,
  };
}

function request(
  update: Partial<ApiProxyProtocolModelRequest> = {},
): ApiProxyProtocolModelRequest {
  return {
    operation: {
      protocol: "openai",
      endpoint: "chat.completions",
      routePath: "/v1/chat/completions",
      transport: "http-json",
    },
    body: { model: "qwen-public" },
    modelId: "qwen-public",
    model: model(),
    stream: false,
    ...update,
  };
}

function planPreview(
  update: Partial<ApiProxyPlanPreview["plan"]> = {},
): ApiProxyPlanPreview {
  return {
    checkedAt: "2026-05-30T10:00:00.000Z",
    runtime: {
      checkedAt: "2026-05-30T10:00:00.000Z",
      targets: [],
    },
    plan: {
      ok: true,
      mode: "request",
      requestedTargetId: target.id,
      blockingReason: null,
      preemptTargetIds: [],
      actions: [
        {
          type: "route-request",
          targetId: target.id,
          instanceId: "instance-a",
          model: target.model,
          slotId: null,
          reason: "target is selected",
        },
      ],
      ...update,
    },
  };
}

test("buildApiProxyProtocolGatewayResponse rejects unbound published model", async () => {
  const response = await buildApiProxyProtocolGatewayResponse({
    adapter: openAiProtocolAdapter,
    request: request({ model: model({ targetId: null }) }),
    getTarget: () => target,
    getPlanPreview: async () => planPreview(),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: {
      message:
        "Model qwen-public is published by arriero, but it is not bound to a proxy target.",
      type: "server_error",
      param: "model",
      code: "arriero_proxy_model_unbound",
    },
  });
});

test("buildApiProxyProtocolGatewayResponse rejects missing target", async () => {
  const response = await buildApiProxyProtocolGatewayResponse({
    adapter: openAiProtocolAdapter,
    request: request(),
    getTarget: () => null,
    getPlanPreview: async () => planPreview(),
  });

  assert.equal(response.status, 503);
  assert.match(
    (response.body as { error: { message: string } }).error.message,
    /missing proxy target target-a/,
  );
});

test("buildApiProxyProtocolGatewayResponse reports blocked scheduler plan", async () => {
  const response = await buildApiProxyProtocolGatewayResponse({
    adapter: openAiProtocolAdapter,
    request: request(),
    getTarget: () => target,
    getPlanPreview: async () =>
      planPreview({
        ok: false,
        blockingReason: "background target is busy",
        actions: [],
      }),
  });

  assert.equal(response.status, 503);
  assert.equal(
    (response.body as { error: { code: string } }).error.code,
    "arriero_proxy_plan_blocked",
  );
});

test("buildApiProxyProtocolGatewayResponse reports readiness actions before forwarding", async () => {
  const response = await buildApiProxyProtocolGatewayResponse({
    adapter: openAiProtocolAdapter,
    request: request(),
    getTarget: () => target,
    getPlanPreview: async () =>
      planPreview({
        actions: [
          {
            type: "load-model",
            targetId: target.id,
            instanceId: "instance-a",
            model: target.model,
            slotId: null,
            reason: "request arrived",
          },
          {
            type: "route-request",
            targetId: target.id,
            instanceId: "instance-a",
            model: target.model,
            slotId: null,
            reason: "target is selected",
          },
        ],
      }),
  });

  assert.equal(response.status, 503);
  assert.equal(
    (response.body as { error: { code: string } }).error.code,
    "arriero_proxy_target_not_ready",
  );
});

test("buildApiProxyProtocolGatewayResponse reaches forwarding stub when target is ready", async () => {
  const response = await buildApiProxyProtocolGatewayResponse({
    adapter: openAiProtocolAdapter,
    request: request(),
    getTarget: () => target,
    getPlanPreview: async () => planPreview(),
  });

  assert.equal(response.status, 501);
  assert.equal(
    (response.body as { error: { code: string } }).error.code,
    "arriero_proxy_not_implemented",
  );
});
