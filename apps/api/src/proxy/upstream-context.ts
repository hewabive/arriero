import type { ApiProxyTargetRecord } from "@llama-manager/core";

import { listInstances } from "../instances/repository.js";
import { apiEndpointAuthHeaders, getApiEndpointById } from "./endpoints.js";
import {
  proxyEngineGates,
  type ProxyEngineGates,
} from "./engine-capabilities.js";
import type {
  ApiProxyProtocolDiagnostic,
  ApiProxyProtocolOperation,
} from "./protocol.js";
import { resolveApiProxyTarget } from "./targets.js";
import { shouldTranslateAnthropicMessages } from "./translation.js";

export type ApiProxyUpstreamContext = {
  baseUrl: string;
  instanceId: string | null;
  engine: ProxyEngineGates;
  authHeaders: Record<string, string>;
  translateAnthropic: boolean;
};

export type ApiProxyUpstreamContextResolution =
  | { ok: true; context: ApiProxyUpstreamContext }
  | { ok: false; diagnostic: ApiProxyProtocolDiagnostic };

export function resolveApiProxyUpstreamContext(input: {
  target: ApiProxyTargetRecord;
  operation: ApiProxyProtocolOperation;
}): ApiProxyUpstreamContextResolution {
  const instances = listInstances();
  const endpoint = getApiEndpointById(input.target.endpointId, instances);
  const targetResolution = resolveApiProxyTarget(
    input.target,
    instances,
    endpoint ? [endpoint] : [],
  );
  if (!targetResolution.enabled) {
    return {
      ok: false,
      diagnostic: {
        status: 503,
        code: "llama_manager_proxy_upstream_unavailable",
        param: "model",
        message:
          targetResolution.error ??
          `Proxy target ${input.target.name} endpoint is unavailable.`,
      },
    };
  }
  const auth = apiEndpointAuthHeaders(targetResolution.endpointId);
  if (!auth.ok) {
    return {
      ok: false,
      diagnostic: {
        status: 503,
        code: "llama_manager_proxy_upstream_unavailable",
        param: "model",
        message: auth.error,
      },
    };
  }
  const translateAnthropic = shouldTranslateAnthropicMessages(
    input.operation,
    targetResolution.profile,
  );
  return {
    ok: true,
    context: {
      baseUrl: targetResolution.baseUrl,
      instanceId: targetResolution.instanceId,
      engine: proxyEngineGates(targetResolution.instance),
      authHeaders: auth.headers,
      translateAnthropic,
    },
  };
}
