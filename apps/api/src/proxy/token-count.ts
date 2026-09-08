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
import { stripV1BaseUrl } from "./targets.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

export type ApiProxyTokenCountResult =
  | { ok: true; tokens: number; detail: string }
  | { ok: false; reason: string };

export type ApiProxyTokenCounter = (
  request: ApiProxyProtocolModelRequest,
  targetId: string,
) => Promise<ApiProxyTokenCountResult>;

function isTextChat(body: unknown): boolean {
  const messages = asObject(body)?.messages;
  return (
    Array.isArray(messages) &&
    messages.every((message) => {
      const item = asObject(message);
      if (!item) return false;
      if (item.audio != null) return false;
      const content = item.content;
      return (
        content == null ||
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.every((part) => {
            const text = asObject(part);
            return text?.type === "text" && typeof text.text === "string";
          }))
      );
    })
  );
}

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
    if (
      endpoint?.nodeId ||
      (instance
        ? engineDescriptor(instance.kind).nativeApi !== "llama"
        : endpoint?.profile !== "llama-native")
    ) {
      return {
        ok: false,
        reason: `target ${target.name}: token counting requires a llama.cpp endpoint without peer delegation`,
      };
    }
    const path = apiProxyOperationSpec(request.operation)?.llamaTokenCountPath;
    if (!path)
      return {
        ok: false,
        reason: "operation does not support exact token counting",
      };
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
      path,
      body: request.body,
      headers: new Headers(),
      instanceId: context.instanceId,
      endpointId: context.endpointId,
    });
    if (!isTextChat(forward.body)) {
      return {
        ok: false,
        reason:
          "exact token counting currently supports text chat requests only",
      };
    }
    const body = {
      ...asObject(forward.body),
      ...(target.model ? { model: target.model } : {}),
    };
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
      const query = new URLSearchParams({ autoload: "false" });
      if (typeof body.model === "string") query.set("model", body.model);
      try {
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
        const response = await fetchImpl(
          apiProxyForwardUrl(context.baseUrl, countPath, "autoload=false"),
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
            redirect: "error",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          return {
            ok: false,
            reason: `target ${targetName}: token counting returned HTTP ${response.status}`,
          };
        }
        const tokens = asObject(await response.json())?.input_tokens;
        if (
          typeof tokens !== "number" ||
          !Number.isSafeInteger(tokens) ||
          tokens < 0
        ) {
          return {
            ok: false,
            reason: `target ${targetName}: invalid input_tokens response`,
          };
        }
        return {
          ok: true,
          tokens,
          detail: `exact ${tokens} tokens for ${targetName} (${targetId}) · llama.cpp`,
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
