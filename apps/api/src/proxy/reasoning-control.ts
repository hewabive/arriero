import type { ApiProxyInflightControlResult } from "@arriero/core";

import { apiProxyForwardUrl } from "./forwarder.js";
import { proxyUpstreamFetch } from "./http.js";
import type { ApiProxyInflightHandle } from "./inflight.js";
import type { ProxyStreamObserver } from "./stream-observer.js";

export function armApiProxyReasoningControl(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  return { ...(body as Record<string, unknown>), reasoning_control: true };
}

export async function endApiProxyUpstreamReasoning(input: {
  baseUrl: string;
  authHeaders: Record<string, string>;
  completionId: string;
  model: string | null;
  fetchImpl?: typeof fetch | undefined;
}): Promise<ApiProxyInflightControlResult> {
  const fetchImpl = input.fetchImpl ?? proxyUpstreamFetch;
  const body: Record<string, unknown> = {
    id: input.completionId,
    action: "reasoning_end",
  };
  if (input.model) {
    body.model = input.model;
  }
  const response = await fetchImpl(
    apiProxyForwardUrl(input.baseUrl, "/v1/chat/completions/control"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...input.authHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    success?: unknown;
    message?: unknown;
  } | null;
  if (response.ok && payload?.success === true) {
    return { status: "ok", message: null };
  }
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : `reasoning control responded ${response.status}`;
  return { status: "failed", message };
}

export function attachApiProxyReasoningControl(input: {
  inflight: ApiProxyInflightHandle;
  observer: ProxyStreamObserver;
  baseUrl: string;
  authHeaders: Record<string, string>;
  model: string | null;
}): ProxyStreamObserver {
  let completionId: string | null = null;
  let responseModel = input.model;
  input.inflight.setControl("force-answer", {
    unavailableReason: () => (completionId === null ? "not-ready" : null),
    execute: () => {
      if (completionId === null) {
        return { status: "not-ready", message: null };
      }
      return endApiProxyUpstreamReasoning({
        baseUrl: input.baseUrl,
        authHeaders: input.authHeaders,
        completionId,
        model: responseModel,
      });
    },
  });
  return {
    ...input.observer,
    onResponseMetadata: (metadata) => {
      input.observer.onResponseMetadata?.(metadata);
      completionId = metadata.id ?? completionId;
      responseModel = metadata.model ?? responseModel;
    },
  };
}
