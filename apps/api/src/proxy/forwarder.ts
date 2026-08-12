import {
  proxyRequestHeaders,
  proxyResponseHeaders,
  proxyTargetUrl,
  proxyUpstreamFetch,
} from "./http.js";
import { stripV1BaseUrl } from "./targets.js";

export type ApiProxyForwardRequest = {
  baseUrl: string;
  method: string;
  upstreamPath: string;
  search: string;
  headers: Headers;
  stripHeaders?: readonly string[] | undefined;
  body: unknown;
  upstreamHeaders?: Record<string, string> | undefined;
  modelOverride?: string | null | undefined;
  signal?: AbortSignal | undefined;
};

export function apiProxyForwardUrl(
  baseUrl: string,
  upstreamPath: string,
  search = "",
) {
  const normalizedBaseUrl = upstreamPath.startsWith("/v1/")
    ? stripV1BaseUrl(baseUrl)
    : baseUrl;
  return proxyTargetUrl(normalizedBaseUrl, upstreamPath, search);
}

function forwardBody(body: unknown, modelOverride: string | null | undefined) {
  if (
    !modelOverride ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return body;
  }

  return {
    ...(body as Record<string, unknown>),
    model: modelOverride,
  };
}

export async function forwardApiProxyRequest(
  input: ApiProxyForwardRequest,
): Promise<Response> {
  const url = apiProxyForwardUrl(
    input.baseUrl,
    input.upstreamPath,
    input.search,
  );

  const headers = proxyRequestHeaders(input.headers);
  for (const name of input.stripHeaders ?? []) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(input.upstreamHeaders ?? {})) {
    headers.set(name, value);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const init: RequestInit = {
    method: input.method,
    headers,
    body: JSON.stringify(forwardBody(input.body, input.modelOverride)),
  };
  if (input.signal) {
    init.signal = input.signal;
  }

  const upstream = await proxyUpstreamFetch(url, init);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  });
}
