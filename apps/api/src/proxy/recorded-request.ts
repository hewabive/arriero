import type { ApiProxyTargetRecord, Instance } from "@arriero/core";

import { instanceEndpointId } from "./endpoints.js";
import { asObject } from "./json.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolId,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

export type RecordedProxyRequest = {
  protocol: ApiProxyProtocolId;
  endpoint: string;
  routePath: string;
  body: unknown;
};

export type PreparedRecordedRequest = {
  path: string;
  body: Record<string, unknown>;
  omittedCacheReadIsZero: boolean;
};

export type RecordedRequestPreparation =
  | { ok: true; request: PreparedRecordedRequest }
  | { ok: false; error: string };

export function instanceUpstreamTarget(
  instance: Instance,
): ApiProxyTargetRecord {
  return {
    id: `instance:${instance.name}`,
    name: instance.name,
    endpointId: instanceEndpointId(instance.name),
    model: null,
    role: "interactive",
    priority: 0,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  };
}

export function recordedRequestOperation(
  recorded: Pick<RecordedProxyRequest, "protocol" | "endpoint" | "routePath">,
): ApiProxyProtocolOperation {
  return {
    protocol: recorded.protocol,
    endpoint: recorded.endpoint,
    routePath: recorded.routePath,
    transport: "http-json",
  };
}

export function prepareRecordedRequestForInstance(
  instance: Instance,
  recorded: RecordedProxyRequest,
): RecordedRequestPreparation {
  const operation = recordedRequestOperation(recorded);
  const spec = apiProxyOperationSpec(operation);
  if (!spec) {
    return {
      ok: false,
      error: `operation ${recorded.protocol} ${recorded.endpoint} is not a proxy operation`,
    };
  }
  const resolved = resolveApiProxyUpstreamContext({
    target: instanceUpstreamTarget(instance),
    operation,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.diagnostic.message };
  }
  const { context } = resolved;
  const forward = prepareApiProxyUpstreamRequest({
    translate: context.translateAnthropic,
    translationDialect: context.translationDialect,
    operation,
    path: spec.upstreamPath,
    body: recorded.body,
    headers: new Headers(),
    instanceId: context.instanceId,
    endpointId: context.endpointId,
  });
  const body = asObject(forward.body);
  if (!body) {
    return { ok: false, error: "the prepared request body is not an object" };
  }
  return {
    ok: true,
    request: {
      path: forward.path,
      body: context.modelOverride
        ? { ...body, model: context.modelOverride }
        : { ...body },
      omittedCacheReadIsZero: context.omittedCacheReadIsZero,
    },
  };
}
