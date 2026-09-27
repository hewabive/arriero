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
import { prepareApiProxyUpstreamRequest } from "./reasoning-request.js";
import { instanceUpstreamTarget } from "./recorded-request.js";
import { apiProxyInstanceReservation } from "./run-reservation.js";
import { getApiProxyTarget } from "./repository.js";
import {
  tokenCountAdapters,
  type ApiProxyTokenMeasurement,
} from "./token-count-adapters.js";
import { stripV1BaseUrl } from "./targets.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

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
  const targetId = target.id;
  const fetchImpl = options.fetchImpl;
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
  const spec = apiProxyOperationSpec(request.operation);
  if (!spec?.tokenCountRequest)
    return {
      ok: false,
      reason: "operation does not support exact token counting",
    };
  const adapter = tokenCountAdapters[adapterId];
  const path = adapter.path;
  const resolved = resolveApiProxyUpstreamContext({
    target,
    operation: request.operation,
  });
  if (!resolved.ok) return { ok: false, reason: resolved.diagnostic.message };
  const context = resolved.context;
  const targetName = target.name;
  const countPath = path;
  const forward = prepareApiProxyUpstreamRequest({
    translate: context.translateAnthropic,
    translationDialect: context.translationDialect,
    operation: request.operation,
    path: spec.upstreamPath,
    body: request.body,
    headers: new Headers(),
    instanceId: context.instanceId,
    endpointId: context.endpointId,
  });
  if (!adapter.supportsRequest(forward.body)) {
    return {
      ok: false,
      reason: `${adapter.name} token counting does not support this chat content`,
    };
  }
  const body = adapter.prepareBody({
    ...asObject(forward.body),
    ...(context.modelOverride ? { model: context.modelOverride } : {}),
  });
  const key = JSON.stringify([targetId, context.baseUrl, path, body]);
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
      if (adapter.llamaReadiness) {
        const query = new URLSearchParams({ autoload: "false" });
        if (typeof body.model === "string") query.set("model", body.model);
        const propsResponse = await fetchImpl(
          apiProxyForwardUrl(
            stripV1BaseUrl(context.baseUrl),
            "/props",
            query.toString(),
          ),
          { headers, signal, redirect: "error" },
        );
        if (!propsResponse.ok) {
          await propsResponse.body?.cancel();
          return {
            ok: false,
            reason: `target ${targetName}: readiness check returned HTTP ${propsResponse.status}`,
          };
        }
        const props = asObject(await propsResponse.json());
        if (props?.is_sleeping !== false) {
          return {
            ok: false,
            reason: `target ${targetName}: model is sleeping or readiness is unknown`,
          };
        }
      }
      const response = await fetchImpl(
        apiProxyForwardUrl(
          context.baseUrl,
          countPath,
          adapter.llamaReadiness ? "autoload=false" : "",
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        },
      );
      if (!response.ok && response.status !== adapter.errorStatus) {
        await response.body?.cancel();
        return {
          ok: false,
          reason: `target ${targetName}: token counting returned HTTP ${response.status}`,
        };
      }
      const measurement = adapter.read(await response.json(), response.status);
      if (!measurement) {
        return {
          ok: false,
          reason: `target ${targetName}: ${response.ok ? `invalid ${adapter.responseField} response` : `token counting returned HTTP ${response.status} without a recognized prompt bound`}`,
        };
      }
      const description =
        "tokens" in measurement
          ? `exact ${measurement.tokens}`
          : `at least ${measurement.minimumTokens}`;
      return {
        ok: true,
        ...measurement,
        detail: `${description} tokens for ${targetName} (${targetId}) · ${adapter.name}`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `target ${targetName}: ${signal.aborted ? "token counting timed out or was cancelled" : "token counting request failed"} (${error instanceof Error ? error.name : "unknown error"})`,
      };
    }
  }
}
