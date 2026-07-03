import type {
  LlamaCapabilitiesResult,
  ApiLabProbeProfile,
  ApiLabProbeTargetRequest,
  ApiProbeRequest,
  ApiProbeResult,
  EndpointProbe,
  LlamaModelActionName,
  LlamaModelActionResult,
  LlamaSlotActionName,
  LlamaSlotActionRequest,
  LlamaSlotActionResult,
  LlamaProbe,
} from "@llama-manager/core";

import { activeNodeScopedPath, apiBase } from "./base.js";
import { formatApiErrorValue, nodeRequest as request } from "./http.js";
import { readApiProbeStream, type ApiProbeStreamCallbacks } from "./sse.js";

export async function getLlamaProbe(id: string) {
  return request<{ data: LlamaProbe }>(`/api/instances/${id}/llama`);
}

export async function getLlamaCapabilities(id: string, force = false) {
  return request<{ data: LlamaCapabilitiesResult }>(
    `/api/instances/${id}/llama/capabilities${force ? "?refresh=true" : ""}`,
  );
}

export async function runInstanceApiProbe(id: string, input: ApiProbeRequest) {
  return request<{ data: ApiProbeResult }>(`/api/instances/${id}/llama/probe`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runApiLabProbe(input: ApiLabProbeTargetRequest) {
  return request<{ data: ApiProbeResult }>("/api/lab/probe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getApiLabModels(
  profile: ApiLabProbeProfile,
  baseUrl: string,
  endpointId?: string | null,
) {
  const params = new URLSearchParams({
    profile,
    ...(baseUrl ? { baseUrl } : {}),
    ...(endpointId ? { endpointId } : {}),
  });
  return request<{ data: EndpointProbe }>(
    `/api/lab/models?${params.toString()}`,
  );
}

export async function streamInstanceApiProbe(
  id: string,
  input: ApiProbeRequest,
  callbacks: ApiProbeStreamCallbacks,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `${apiBase}${activeNodeScopedPath(`/api/instances/${id}/llama/probe/stream`)}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: signal ?? null,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    let parsed: { error?: unknown } | null = null;
    try {
      parsed = JSON.parse(error) as { error?: unknown };
    } catch {
      parsed = null;
    }
    throw new Error(
      formatApiErrorValue(parsed?.error) || error || response.statusText,
    );
  }

  await readApiProbeStream(response, callbacks);
}

export async function streamApiLabProbe(
  input: ApiLabProbeTargetRequest,
  callbacks: ApiProbeStreamCallbacks,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `${apiBase}${activeNodeScopedPath("/api/lab/probe/stream")}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: signal ?? null,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    let parsed: { error?: unknown } | null = null;
    try {
      parsed = JSON.parse(error) as { error?: unknown };
    } catch {
      parsed = null;
    }
    throw new Error(
      formatApiErrorValue(parsed?.error) || error || response.statusText,
    );
  }

  await readApiProbeStream(response, callbacks);
}

export async function llamaModelAction(
  id: string,
  action: Exclude<LlamaModelActionName, "reload">,
  model: string,
) {
  return request<{ data: LlamaModelActionResult }>(
    `/api/instances/${id}/llama/models/${action}`,
    {
      method: "POST",
      body: JSON.stringify({ model }),
    },
  );
}

export async function reloadLlamaModels(id: string) {
  return request<{ data: LlamaModelActionResult }>(
    `/api/instances/${id}/llama/models/reload`,
    {
      method: "POST",
    },
  );
}

export async function llamaSlotAction(
  id: string,
  action: LlamaSlotActionName,
  slotId: number,
  input: LlamaSlotActionRequest = {},
) {
  return request<{ data: LlamaSlotActionResult }>(
    `/api/instances/${id}/llama/slots/${slotId}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
