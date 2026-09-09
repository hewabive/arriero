import { engineDescriptor } from "@arriero/core";

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

export function createApiProxyTokenCounter(
  options: {
    signal?: AbortSignal | undefined;
    fetchImpl?: typeof fetch | undefined;
  } = {},
): ApiProxyTokenCounter {
  const cache = new Map<string, Promise<ApiProxyTokenCountResult>>();
  const fetchImpl = options.fetchImpl ?? proxyUpstreamFetch;

  return async (request, targetId) => {
    const target = getApiProxyTarget(targetId);
    if (!target) return { ok: false, reason: `target ${targetId} not found` };
    const endpoint = getApiEndpointById(target.endpointId, listInstances());
    const instance = endpoint?.instanceId
      ? getInstance(endpoint.instanceId)
      : null;
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
      ...(target.model ? { model: target.model } : {}),
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
        AbortSignal.timeout(3000),
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
        const measurement = adapter.read(
          await response.json(),
          response.status,
        );
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
  };
}
