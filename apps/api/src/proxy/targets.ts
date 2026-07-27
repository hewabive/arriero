import type {
  ApiEndpointRecord,
  ApiLabProbeProfile,
  ApiProxyTargetRecord,
  Instance,
} from "@arriero/core";

import { config } from "../config.js";

export type ApiProxyTargetResolution = {
  kind: "managed-instance" | "external-api";
  endpointId: string;
  baseUrl: string;
  profile: ApiLabProbeProfile;
  enabled: boolean;
  instance: Instance | null;
  instanceId: string | null;
  error: string | null;
};

export function normalizeHttpBaseUrl(value: string) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path === "/" ? "" : path}`;
}

export function stripV1BaseUrl(value: string) {
  return normalizeHttpBaseUrl(value).replace(/\/v1$/i, "");
}

export function apiVersionBaseUrl(value: string) {
  const normalized = normalizeHttpBaseUrl(value);
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

export function resolveApiProxyTarget(
  target: ApiProxyTargetRecord,
  instances: Instance[],
  endpoints: ApiEndpointRecord[],
): ApiProxyTargetResolution {
  const endpoint = endpoints.find((item) => item.id === target.endpointId);
  if (!endpoint) {
    return {
      kind: "external-api",
      endpointId: target.endpointId,
      baseUrl: "http://127.0.0.1",
      profile: "openai",
      enabled: false,
      instance: null,
      instanceId: null,
      error: `API endpoint ${target.endpointId} not found`,
    };
  }

  if (endpoint.kind === "manager-proxy") {
    return {
      kind: "external-api",
      endpointId: endpoint.id,
      baseUrl: endpoint.baseUrl,
      profile: endpoint.profile,
      enabled: false,
      instance: null,
      instanceId: null,
      error: "proxy target cannot point to arriero proxy itself",
    };
  }

  if (endpoint.nodeId) {
    return {
      kind: "external-api",
      endpointId: endpoint.id,
      baseUrl: endpoint.baseUrl,
      profile: endpoint.profile,
      enabled: endpoint.enabled,
      instance: null,
      instanceId: null,
      error: endpoint.enabled
        ? null
        : `API endpoint ${endpoint.name} is disabled`,
    };
  }

  const instance = endpoint.instanceId
    ? (instances.find((item) => item.name === endpoint.instanceId) ?? null)
    : null;

  return {
    kind:
      endpoint.kind === "managed-instance"
        ? "managed-instance"
        : "external-api",
    endpointId: endpoint.id,
    baseUrl: normalizeHttpBaseUrl(endpoint.baseUrl),
    profile: endpoint.profile,
    enabled:
      endpoint.enabled &&
      (endpoint.kind !== "managed-instance" || Boolean(instance)),
    instance,
    instanceId: instance?.name ?? null,
    error:
      endpoint.enabled && (endpoint.kind !== "managed-instance" || instance)
        ? null
        : endpoint.enabled
          ? `managed instance ${endpoint.instanceId ?? endpoint.id} not found`
          : `API endpoint ${endpoint.name} is disabled`,
  };
}

function portNumber(url: URL) {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function normalizedHostname(value: string) {
  return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isLocalHostname(value: string) {
  const hostname = normalizedHostname(value);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function isManagerProxyBaseUrl(value: string) {
  const parsed = new URL(stripV1BaseUrl(value));
  if (portNumber(parsed) !== config.port) {
    return false;
  }

  const hostname = normalizedHostname(parsed.hostname);
  const configuredHost = normalizedHostname(config.host);
  if (hostname === configuredHost) {
    return true;
  }

  if (
    configuredHost === "0.0.0.0" ||
    configuredHost === "::" ||
    isLocalHostname(configuredHost)
  ) {
    return isLocalHostname(hostname);
  }

  return false;
}
