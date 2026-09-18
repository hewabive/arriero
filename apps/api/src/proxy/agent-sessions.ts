import type { Context, Hono } from "hono";
import { logger } from "../logger.js";
import { apiEndpointAuthHeaders, getExternalApiEndpoint } from "./endpoints.js";
import { apiProxyDrainBody, isApiProxyDraining } from "./drain.js";
import { forwardApiProxyRequest } from "./forwarder.js";
import { CLIENT_ABORT_STATUS, describeFetchError } from "./http.js";
import { openAiProtocolAdapter } from "./openai.js";
import { runWithProxyTrace } from "./protocol-endpoint.js";
import { applyTraceDiagnostic } from "./protocol-trace.js";
import { getApiProxySettings } from "./settings.js";
import { apiProxyRequestGate } from "./sources.js";

type AgentSessionOperation = {
  method: "GET" | "POST";
  endpoint: string;
  path: string;
  upstreamPath: (c: Context) => string;
};

const agentSessionOperations: AgentSessionOperation[] = [
  {
    method: "GET",
    endpoint: "agent-requests.get",
    path: "/agent-requests/:requestId",
    upstreamPath: (c) =>
      `/v1/agent-requests/${encodeURIComponent(c.req.param("requestId")!)}`,
  },
  {
    method: "POST",
    endpoint: "agent-sessions.clones",
    path: "/agent-sessions/clones",
    upstreamPath: () => "/v1/agent-sessions/clones",
  },
];

async function proxyAgentSession(
  c: Context,
  operation: AgentSessionOperation,
  prefix: string,
): Promise<Response> {
  if (isApiProxyDraining()) {
    c.header("retry-after", "5");
    return c.json(apiProxyDrainBody(openAiProtocolAdapter), 503);
  }
  return runWithProxyTrace(
    {
      protocol: "openai",
      endpoint: operation.endpoint,
      routePath: prefix + operation.path,
      transport: "http-json",
    },
    async ({ trace, inflight }) => {
      const { resolution, rejection } = apiProxyRequestGate(c.req.raw.headers);
      if (resolution.kind === "source") {
        trace.sourceId = resolution.id;
        trace.sourceName = resolution.name;
        inflight.setSource(resolution.id, resolution.name);
      }
      if (rejection) {
        applyTraceDiagnostic(trace, rejection);
        const response = openAiProtocolAdapter.authError(rejection);
        return c.json(response.body, response.status);
      }
      const endpointId = getApiProxySettings().agentSessionEndpointId;
      const endpoint = endpointId ? getExternalApiEndpoint(endpointId) : null;
      if (!endpoint?.enabled) {
        applyTraceDiagnostic(trace, {
          code: "agent_session_endpoint_unavailable",
          message:
            "Agent session API endpoint is not configured or is disabled.",
        });
        return c.json(
          openAiProtocolAdapter.unavailableError(trace.errorMessage!),
          503,
        );
      }
      trace.targetId = `endpoint:${endpoint.id}`;
      trace.targetName = endpoint.name;
      trace.stream = false;
      inflight.setTarget(trace.targetId);
      inflight.setStream(false);
      const auth = apiEndpointAuthHeaders(endpoint.id);
      if (!auth.ok) {
        applyTraceDiagnostic(trace, {
          code: "agent_session_endpoint_auth_unavailable",
          message: auth.error,
        });
        return c.json(openAiProtocolAdapter.unavailableError(auth.error), 503);
      }
      let body: unknown;
      if (operation.method === "POST") {
        try {
          body = await c.req.json();
        } catch {
          applyTraceDiagnostic(trace, {
            code: "invalid_json",
            message: "Request body must be valid JSON.",
          });
          return c.json(
            {
              error: {
                message: trace.errorMessage,
                type: "invalid_request_error",
                code: "invalid_json",
              },
            },
            400,
          );
        }
      }
      const signal = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(15_000),
      ]);
      try {
        inflight.dispatched();
        const response = await forwardApiProxyRequest({
          baseUrl: endpoint.baseUrl,
          method: operation.method,
          upstreamPath: operation.upstreamPath(c),
          search: new URL(c.req.url).search,
          headers: c.req.raw.headers,
          upstreamHeaders: auth.headers,
          body,
          signal,
        });
        const payload = response.body ? await response.arrayBuffer() : null;
        response.headers.set("cache-control", "no-store");
        return new Response(payload, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        applyTraceDiagnostic(trace, {
          code: "agent_session_upstream_error",
          message: describeFetchError(error),
        });
        if (c.req.raw.signal.aborted)
          return new Response(null, { status: CLIENT_ABORT_STATUS });
        logger.warn(
          {
            err: error,
            endpointId: endpoint.id,
            operation: operation.endpoint,
          },
          "agent session forwarding failed",
        );
        return c.json(
          openAiProtocolAdapter.unavailableError(
            "Agent session API request failed.",
          ),
          signal.aborted ? 504 : 502,
        );
      }
    },
  );
}

export function registerAgentSessionProxyRoutes(
  app: Hono,
  prefix: string,
): void {
  for (const operation of agentSessionOperations) {
    app.on(operation.method, prefix + operation.path, (c) =>
      proxyAgentSession(c, operation, prefix),
    );
  }
}
