import {
  instanceHttpAddress,
  probeReachableHost,
  type Instance,
  type InstanceHttpSource,
  type EndpointProbe,
} from "@arriero/core";

const PROBE_TIMEOUT_MS = 1_500;

export function instanceBaseUrl(instance: InstanceHttpSource): string {
  const address = instanceHttpAddress(instance);
  if (!address) {
    return "";
  }
  return `http://${probeReachableHost(address.host)}:${address.port}${address.prefix}`;
}

export function rpcWorkerEndpoint(
  instance: Pick<Instance, "args">,
): { host: string; port: number } | null {
  const address = instanceHttpAddress({
    kind: "rpc-worker",
    args: instance.args,
  });
  if (!address) {
    return null;
  }
  return { host: probeReachableHost(address.host), port: address.port };
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
