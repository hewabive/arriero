import {
  ApiProxyModelRecordSchema,
  type ApiProxyServeRequest,
  type ApiProxyTargetRecord,
} from "@arriero/core";
import type { Context } from "hono";

import { getInstance } from "../instances/repository.js";
import { anthropicProtocolAdapter } from "./anthropic.js";
import { withDelegatedTraceHeader } from "./delegated-trace.js";
import { instanceEndpointId } from "./endpoints.js";
import { openAiProtocolAdapter } from "./openai.js";
import { runWithProxyTrace, serveResolvedTarget } from "./protocol-endpoint.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolOperation,
} from "./protocol.js";

function adapterForProtocol(
  protocol: ApiProxyServeRequest["protocol"],
): ApiProxyProtocolAdapter {
  return protocol === "anthropic"
    ? anthropicProtocolAdapter
    : openAiProtocolAdapter;
}

function serveOperation(
  protocol: ApiProxyServeRequest["protocol"],
  endpoint: string,
): ApiProxyProtocolOperation {
  return {
    protocol,
    endpoint,
    routePath: `/${protocol}/${endpoint}`,
    transport: "http-json",
  };
}

export function ephemeralTarget(
  payload: ApiProxyServeRequest,
): ApiProxyTargetRecord {
  return {
    id: `serve:${payload.instanceId}`,
    name: payload.instanceId,
    endpointId: instanceEndpointId(payload.instanceId),
    model: payload.model,
    role: payload.role,
    priority: payload.priority,
    preemptible: payload.preemptible,
    saveSlotsBeforeUnload: payload.saveSlotsBeforeUnload,
    slotIds: payload.slotIds,
    idleUnloadMs: null,
  };
}

export async function serveApiProxyPinnedInstance(
  c: Context,
  payload: ApiProxyServeRequest,
): Promise<Response> {
  if (!getInstance(payload.instanceId)) {
    return c.json(
      {
        error: {
          message: `Instance ${payload.instanceId} not found on this node`,
          type: "not_found",
        },
      },
      404,
    );
  }

  const adapter = adapterForProtocol(payload.protocol);
  const operation = serveOperation(payload.protocol, payload.endpoint);
  const target = ephemeralTarget(payload);
  const modelId = adapter.modelIdFromBody(payload.body) ?? payload.instanceId;
  const model = ApiProxyModelRecordSchema.parse({
    id: target.id,
    modelId,
    enabled: true,
    ownedBy: "arriero",
    targetId: target.id,
    routeTo: null,
    description: null,
  });
  const request: ApiProxyProtocolModelRequest = {
    operation,
    body: payload.body,
    modelId,
    model,
    stream: payload.stream,
  };

  return runWithProxyTrace(operation, async ({ trace, recorder, inflight }) => {
    trace.modelId = modelId;
    trace.targetId = target.id;
    trace.targetName = target.name;
    trace.stream = payload.stream;
    inflight.setModel(modelId);
    inflight.setTarget(target.id);
    inflight.setStream(payload.stream);
    const response = await serveResolvedTarget({
      c,
      adapter,
      operation,
      targetId: target.id,
      request,
      trace,
      recorder,
      inflight,
      extraTarget: target,
    });
    return withDelegatedTraceHeader(response, trace.id);
  });
}
