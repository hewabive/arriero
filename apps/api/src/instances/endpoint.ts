import {
  engineDescriptor,
  type Instance,
  type InstanceArgValue,
  type EndpointProbe,
} from "@llama-manager/core";

const RPC_HTTP = engineDescriptor("rpc-worker").http;
const PROBE_TIMEOUT_MS = 1_500;

export function firstArg(
  args: Instance["args"],
  keys: readonly string[],
): InstanceArgValue | undefined {
  for (const key of keys) {
    if (args[key] !== undefined) {
      return args[key];
    }
  }
  return undefined;
}

export function asString(
  value: InstanceArgValue | undefined,
  fallback: string,
): string {
  if (value === undefined || value === null || Array.isArray(value)) {
    return fallback;
  }
  return String(value);
}

export function asPort(
  value: InstanceArgValue | undefined,
  defaultPort = 8080,
): number {
  const raw = asString(value, String(defaultPort));
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;
}

export function probeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

export function apiPrefix(instance: Instance): string {
  const http = engineDescriptor(instance.kind ?? "llama-server").http;
  const raw = asString(firstArg(instance.args, http.apiPrefixArgKeys), "");
  if (!raw) {
    return "";
  }
  return raw.startsWith("/")
    ? raw.replace(/\/$/, "")
    : `/${raw.replace(/\/$/, "")}`;
}

export function instanceBaseUrl(instance: Instance): string {
  const http = engineDescriptor(instance.kind ?? "llama-server").http;
  const rawHost = asString(
    firstArg(instance.args, http.hostArgKeys),
    http.defaultHost,
  );
  const port = asPort(
    firstArg(instance.args, http.portArgKeys),
    http.defaultPort,
  );
  const host = probeHost(rawHost);

  if (host.endsWith(".sock")) {
    return "";
  }

  return `http://${host}:${port}${apiPrefix(instance)}`;
}

export function rpcWorkerEndpoint(
  instance: Pick<Instance, "args">,
): { host: string; port: number } | null {
  const host = probeHost(
    asString(
      firstArg(instance.args, RPC_HTTP.hostArgKeys),
      RPC_HTTP.defaultHost,
    ),
  );
  if (host.endsWith(".sock")) {
    return null;
  }
  const port = asPort(
    firstArg(instance.args, RPC_HTTP.portArgKeys),
    RPC_HTTP.defaultPort,
  );
  return { host, port };
}

export async function requestJsonProbe(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<EndpointProbe> {
  const { timeoutMs = PROBE_TIMEOUT_MS, ...requestInit } = init;
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    return {
      ok: response.ok,
      url,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      body,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      latencyMs: Math.round(performance.now() - started),
      error: (error as Error).message,
    };
  }
}

export async function probeJson(url: string): Promise<EndpointProbe> {
  return requestJsonProbe(url);
}

export function objectBody(
  probe: EndpointProbe,
): Record<string, unknown> | null {
  return probe.body &&
    typeof probe.body === "object" &&
    !Array.isArray(probe.body)
    ? (probe.body as Record<string, unknown>)
    : null;
}

export function compactOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function modelRecordsFromProbe(
  probe: EndpointProbe,
): Array<{ id: string; status: string | null }> {
  const body = probe.body;
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { data?: unknown }).data
      : null;
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const status =
        record.status &&
        typeof record.status === "object" &&
        !Array.isArray(record.status)
          ? (record.status as Record<string, unknown>)
          : null;
      const id = typeof record.id === "string" ? record.id : null;
      if (!id) {
        return null;
      }
      return {
        id,
        status:
          status?.failed === true
            ? "failed"
            : typeof status?.value === "string"
              ? status.value
              : null,
      };
    })
    .filter((item): item is { id: string; status: string | null } =>
      Boolean(item),
    )
    .sort((left, right) =>
      left.id.localeCompare(right.id, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}
