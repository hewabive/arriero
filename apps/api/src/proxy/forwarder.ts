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

export function apiProxyUpstreamHeaders(
  clientHeaders: Headers,
  shaping: {
    strip?: readonly string[] | undefined;
    upstream?: Record<string, string> | undefined;
  },
): Headers {
  const headers = proxyRequestHeaders(clientHeaders);
  for (const name of shaping.strip ?? []) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(shaping.upstream ?? {})) {
    headers.set(name, value);
  }
  return headers;
}

export function apiProxyPassthroughResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  });
}

export async function forwardApiProxyRequest(
  input: ApiProxyForwardRequest,
): Promise<Response> {
  const url = apiProxyForwardUrl(
    input.baseUrl,
    input.upstreamPath,
    input.search,
  );

  const headers = apiProxyUpstreamHeaders(input.headers, {
    strip: input.stripHeaders,
    upstream: input.upstreamHeaders,
  });
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const init: RequestInit = {
    method: input.method,
    headers,
    body: JSON.stringify(input.body),
  };
  if (input.signal) {
    init.signal = input.signal;
  }

  return apiProxyPassthroughResponse(await proxyUpstreamFetch(url, init));
}
