import {
  argString,
  type ApiEndpointRecord,
  type ApiEndpointStreamTerminal,
  type ApiProxyTargetRecord,
  type Instance,
} from "@arriero/core";

import { listInstances } from "../instances/repository.js";
import { apiEndpointAuthHeaders, getApiEndpointById } from "./endpoints.js";
import {
  proxyEngineGates,
  type ProxyEngineGates,
} from "./engine-capabilities.js";
import { CLIENT_METRICS_LABEL_HEADER } from "./http.js";
import type {
  ApiProxyProtocolDiagnostic,
  ApiProxyProtocolOperation,
} from "./protocol.js";
import { getApiProxySettings } from "./settings.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle.js";
import { resolveApiProxyTarget } from "./targets.js";
import { shouldTranslateAnthropicMessages } from "./translation.js";

export type ApiProxyUpstreamContext = {
  baseUrl: string;
  instanceId: string | null;
  endpointId: string | null;
  engine: ProxyEngineGates;
  authHeaders: Record<string, string>;
  translateAnthropic: boolean;
  stripClientHeaders: string[];
  streamTerminal: ApiEndpointStreamTerminal;
  streamIdleTimeoutMs: number | null;
};

function apiEndpointStreamTerminal(
  endpoint: ApiEndpointRecord | null,
): ApiEndpointStreamTerminal {
  if (endpoint?.streamTerminal) {
    return endpoint.streamTerminal;
  }
  return endpoint?.kind === "external-api" ? "tolerant" : "strict";
}

function apiEndpointStreamIdleTimeoutMs(
  endpoint: ApiEndpointRecord | null,
): number | null {
  const configured =
    endpoint?.streamIdleTimeoutMs ??
    getApiProxySettings().streamIdleTimeoutMs ??
    DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return configured === 0 ? null : configured;
}

const METRICS_LABEL_HEADER_ARG = "--tokenizer-metrics-custom-labels-header";

export function instanceMetricsLabelHeader(
  instance: Instance | null,
): string | null {
  if (!instance) {
    return null;
  }
  const name =
    argString(instance.args, [METRICS_LABEL_HEADER_ARG])?.toLowerCase() ?? null;
  return name && name !== CLIENT_METRICS_LABEL_HEADER ? name : null;
}

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
        code: "arriero_proxy_upstream_unavailable",
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
        code: "arriero_proxy_upstream_unavailable",
        param: "model",
        message: auth.error,
      },
    };
  }
  const translateAnthropic = shouldTranslateAnthropicMessages(
    input.operation,
    targetResolution.profile,
  );
  const renamedMetricsLabelHeader = instanceMetricsLabelHeader(
    targetResolution.instance,
  );
  return {
    ok: true,
    context: {
      baseUrl: targetResolution.baseUrl,
      instanceId: targetResolution.instanceId,
      endpointId: targetResolution.endpointId,
      engine: proxyEngineGates(targetResolution.instance),
      authHeaders: auth.headers,
      translateAnthropic,
      stripClientHeaders: renamedMetricsLabelHeader
        ? [renamedMetricsLabelHeader]
        : [],
      streamTerminal: apiEndpointStreamTerminal(endpoint),
      streamIdleTimeoutMs: apiEndpointStreamIdleTimeoutMs(endpoint),
    },
  };
}
