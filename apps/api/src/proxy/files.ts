import type { Context, Hono } from "hono";

import {
  apiEndpointAuthHeaders,
  listExternalApiEndpoints,
} from "./endpoints.js";
import { apiProxyForwardUrl } from "./forwarder.js";
import {
  CLIENT_ABORT_STATUS,
  describeFetchError,
  proxyRequestHeaders,
  proxyResponseHeaders,
  proxyUpstreamFetch,
} from "./http.js";
import { openAiProtocolAdapter } from "./openai.js";
import { apiProxyFileOperationSpecs } from "./protocol.js";
import { apiProxyRequestGate } from "./sources.js";
import { getApiProxySettings } from "./settings.js";

const endpointHeader = "x-arriero-endpoint";

async function proxyFilesEndpoint(
  c: Context,
  operation: (typeof apiProxyFileOperationSpecs)[number],
) {
  const { rejection } = apiProxyRequestGate(c.req.raw.headers);
  if (rejection) {
    const response = openAiProtocolAdapter.authError(rejection);
    return c.json(response.body, response.status);
  }

  const endpoints = listExternalApiEndpoints().filter(
    (endpoint) => endpoint.enabled && endpoint.profile === "openai",
  );
  const endpointId =
    c.req.header(endpointHeader)?.trim() ||
    getApiProxySettings().filesEndpointId;
  const endpoint = endpointId
    ? endpoints.find((item) => item.id === endpointId)
    : endpoints.length === 1
      ? endpoints[0]
      : null;
  if (!endpoint) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          code: "arriero_proxy_files_endpoint_required",
          message:
            "Files API requires an enabled external OpenAI endpoint. Select a valid default Files API endpoint in proxy settings or provide X-Arriero-Endpoint. Without either, exactly one eligible endpoint must be configured.",
          param: "X-Arriero-Endpoint",
        },
      },
      400,
    );
  }

  const auth = apiEndpointAuthHeaders(endpoint.id);
  if (!auth.ok) {
    return c.json(openAiProtocolAdapter.unavailableError(auth.error), 503);
  }

  const fileId = c.req.param("fileId");
  if (fileId === "." || fileId === "..") {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          code: "invalid_file_id",
          message: "Invalid file ID.",
          param: "file_id",
        },
      },
      400,
    );
  }
  const upstreamPath = `/v1${operation.path.replace(
    ":fileId",
    encodeURIComponent(fileId ?? ""),
  )}`;
  const headers = proxyRequestHeaders(c.req.raw.headers);
  for (const name of ["authorization", "x-api-key", endpointHeader]) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(auth.headers)) {
    headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: operation.method,
    headers,
    signal: c.req.raw.signal,
    redirect: "manual",
  };
  if (operation.bodyMode === "stream") {
    init.body = c.req.raw.body;
    init.duplex = "half";
  }

  try {
    const response = await proxyUpstreamFetch(
      apiProxyForwardUrl(
        endpoint.baseUrl,
        upstreamPath,
        new URL(c.req.url).search,
      ),
      init,
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyResponseHeaders(response.headers),
    });
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: CLIENT_ABORT_STATUS });
    }
    return c.json(
      openAiProtocolAdapter.unavailableError(describeFetchError(error)),
      502,
    );
  }
}

export function registerOpenAiFilesRoutes(app: Hono, prefix: string) {
  for (const operation of apiProxyFileOperationSpecs) {
    app.on(operation.method, `${prefix}${operation.path}`, (c) =>
      proxyFilesEndpoint(c, operation),
    );
  }
}
