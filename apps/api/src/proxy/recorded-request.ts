import type { ApiProxyTargetRecord, Instance } from "@arriero/core";

import { instanceEndpointId } from "./endpoints.js";
import { asObject } from "./json.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolId,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
import {
  resolveApiProxyUpstreamContext,
  type ApiProxyUpstreamContext,
  type ApiProxyUpstreamContextResolution,
} from "./upstream-context.js";

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

type ApiProxyTargetRequestPreparation =
  | {
      ok: true;
      context: ApiProxyUpstreamContext;
      path: string;
      body: unknown;
    }
  | { ok: false; error: string };

export function prepareApiProxyRequestForTarget(
  target: ApiProxyTargetRecord,
  operation: ApiProxyProtocolOperation,
  body: unknown,
  resolveContext: typeof resolveApiProxyUpstreamContext = resolveApiProxyUpstreamContext,
): ApiProxyTargetRequestPreparation {
  const spec = apiProxyOperationSpec(operation);
  if (!spec) {
    return {
      ok: false,
      error: `operation ${operation.protocol} ${operation.endpoint} is not a proxy operation`,
    };
  }
  const resolved = resolveContext({ target, operation });
  if (!resolved.ok) {
    return { ok: false, error: resolved.diagnostic.message };
  }
  const forward = prepareApiProxyUpstreamRequest({
    context: resolved.context,
    operation,
    path: spec.upstreamPath,
    body,
    headers: new Headers(),
  });
  return {
    ok: true,
    context: resolved.context,
    path: forward.path,
    body: forward.body,
  };
}

export function recordedRequestPreparer(
  instance: Instance,
): (recorded: RecordedProxyRequest) => RecordedRequestPreparation {
  const target = instanceUpstreamTarget(instance);
  const resolutions = new Map<string, ApiProxyUpstreamContextResolution>();
  const resolveContext: typeof resolveApiProxyUpstreamContext = (input) => {
    const { protocol, endpoint, routePath } = input.operation;
    const key = JSON.stringify([protocol, endpoint, routePath]);
    let resolution = resolutions.get(key);
    if (!resolution) {
      resolution = resolveApiProxyUpstreamContext(input);
      resolutions.set(key, resolution);
    }
    return resolution;
  };
  return (recorded) => {
    const prepared = prepareApiProxyRequestForTarget(
      target,
      recordedRequestOperation(recorded),
      recorded.body,
      resolveContext,
    );
    if (!prepared.ok) {
      return prepared;
    }
    const body = asObject(prepared.body);
    if (!body) {
      return { ok: false, error: "the prepared request body is not an object" };
    }
    return {
      ok: true,
      request: {
        path: prepared.path,
        body: { ...body },
        omittedCacheReadIsZero: prepared.context.omittedCacheReadIsZero,
      },
    };
  };
}
