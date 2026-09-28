import {
  engineDescriptor,
  type ApiEndpointRecord,
  type ApiProxyTargetRecord,
  type Instance,
} from "@arriero/core";

import { getInstance, listInstances } from "../instances/repository.js";
import { getApiEndpointById } from "./endpoints.js";
import { apiProxyForwardUrl } from "./forwarder.js";
import { proxyUpstreamFetch } from "./http.js";
import { asObject } from "./json.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolModelRequest,
} from "./protocol.js";
import {
  instanceUpstreamTarget,
  prepareApiProxyRequestForTarget,
} from "./recorded-request.js";
import { apiProxyInstanceReservation } from "./run-reservation.js";
import { getApiProxyTarget } from "./repository.js";
import {
  tokenCountAdapters,
  type ApiProxyTokenMeasurement,
} from "./token-count-adapters.js";

type ApiProxyTokenCountResult =
  | ({ ok: true; detail: string } & ApiProxyTokenMeasurement)
  | { ok: false; reason: string };

export type ApiProxyTokenCounter = (
  request: ApiProxyProtocolModelRequest,
  targetId: string,
) => Promise<ApiProxyTokenCountResult>;

type CountSubject = {
  target: ApiProxyTargetRecord;
  endpoint: ApiEndpointRecord | null;
  instance: Instance | null;
};

type CountFetch = (url: string, init: RequestInit) => Promise<Response>;

type CountOptions = {
  fetchImpl: CountFetch;
  signal: AbortSignal | undefined;
  timeoutMs: number;
};

const DEFAULT_COUNT_TIMEOUT_MS = 3000;

export function createApiProxyTokenCounter(
  options: {
    signal?: AbortSignal | undefined;
    fetchImpl?: typeof fetch | undefined;
  } = {},
): ApiProxyTokenCounter {
  const cache = new Map<string, Promise<ApiProxyTokenCountResult>>();
  const countOptions: CountOptions = {
    fetchImpl: options.fetchImpl ?? proxyUpstreamFetch,
    signal: options.signal,
    timeoutMs: DEFAULT_COUNT_TIMEOUT_MS,
  };

  return async (request, targetId) => {
    const target = getApiProxyTarget(targetId);
    if (!target) return { ok: false, reason: `target ${targetId} not found` };
    const endpoint = getApiEndpointById(target.endpointId, listInstances());
    const instance = endpoint?.instanceId
      ? getInstance(endpoint.instanceId)
      : null;
    return countSubjectTokens(
      { target, endpoint, instance },
      request,
      countOptions,
      cache,
    );
  };
}

export function countInstancePromptTokens(
  instance: Instance,
  request: Pick<ApiProxyProtocolModelRequest, "operation" | "body">,
  options: {
    fetchImpl?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<ApiProxyTokenCountResult> {
  const target = instanceUpstreamTarget(instance);
  return countSubjectTokens(
    {
      target,
      endpoint: getApiEndpointById(target.endpointId, listInstances()),
      instance,
    },
    request,
    {
      fetchImpl: options.fetchImpl ?? proxyUpstreamFetch,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_COUNT_TIMEOUT_MS,
    },
    new Map(),
  );
}

async function countSubjectTokens(
  subject: CountSubject,
  request: Pick<ApiProxyProtocolModelRequest, "operation" | "body">,
  options: CountOptions,
  cache: Map<string, Promise<ApiProxyTokenCountResult>>,
): Promise<ApiProxyTokenCountResult> {
  const { target, endpoint, instance } = subject;
  const reservation = apiProxyInstanceReservation(instance?.name ?? null);
  if (reservation) {
    return {
      ok: false,
      reason: `target ${target.name}: reserved by benchmark run ${reservation.label}`,
    };
  }
  const adapterId = instance
    ? engineDescriptor(instance.kind).proxy.tokenCount
    : endpoint?.profile === "llama-native"
      ? "llama"
      : "none";
  if (endpoint?.nodeId || adapterId === "none") {
    return {
      ok: false,
      reason: `target ${target.name}: upstream token counting is unsupported for this endpoint or peer delegation`,
    };
  }
  if (!apiProxyOperationSpec(request.operation)?.tokenCountRequest)
    return {
      ok: false,
      reason: "operation does not support exact token counting",
    };
  const adapter = tokenCountAdapters[adapterId];
  const prepared = prepareApiProxyRequestForTarget(
    target,
    request.operation,
    request.body,
  );
  if (!prepared.ok) return { ok: false, reason: prepared.error };
  const { context } = prepared;
  if (!adapter.supportsRequest(prepared.body)) {
    return {
      ok: false,
      reason: `${adapter.name} token counting does not support this chat content`,
    };
  }
  const body = adapter.prepareBody({ ...asObject(prepared.body) });
  const payload = JSON.stringify(body);
  const key = JSON.stringify([
    target.id,
    context.baseUrl,
    adapter.path,
    payload,
  ]);
  let result = cache.get(key);
  if (!result) {
    result = count();
    cache.set(key, result);
  }
  return result;

  async function count(): Promise<ApiProxyTokenCountResult> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    const headers = {
      ...context.authHeaders,
      "content-type": "application/json",
    };
    try {
      if (adapter.readiness) {
        const unready = await adapter.readiness({
          baseUrl: context.baseUrl,
          model: body.model,
          headers,
          signal,
          fetchImpl: options.fetchImpl,
        });
        if (unready !== null) {
          return { ok: false, reason: `target ${target.name}: ${unready}` };
        }
      }
      const response = await options.fetchImpl(
        apiProxyForwardUrl(context.baseUrl, adapter.path, adapter.countQuery),
        {
          method: "POST",
          headers,
          body: payload,
          signal,
          redirect: "error",
        },
      );
      if (!response.ok && response.status !== adapter.errorStatus) {
        await response.body?.cancel();
        return {
          ok: false,
          reason: `target ${target.name}: token counting returned HTTP ${response.status}`,
        };
      }
      const measurement = adapter.read(await response.json(), response.status);
      if (!measurement) {
        return {
          ok: false,
          reason: `target ${target.name}: ${response.ok ? `invalid ${adapter.responseField} response` : `token counting returned HTTP ${response.status} without a recognized prompt bound`}`,
        };
      }
      const description =
        "tokens" in measurement
          ? `exact ${measurement.tokens}`
          : `at least ${measurement.minimumTokens}`;
      return {
        ok: true,
        ...measurement,
        detail: `${description} tokens for ${target.name} (${target.id}) · ${adapter.name}`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `target ${target.name}: ${signal.aborted ? "token counting timed out or was cancelled" : "token counting request failed"} (${error instanceof Error ? error.name : "unknown error"})`,
      };
    }
  }
}
