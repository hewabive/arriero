import type { Hono } from "hono";

import { anthropicProtocolAdapter } from "./anthropic.js";
import { getApiProxyPublicModelStatuses } from "./model-status.js";
import { openAiModelsList, openAiProtocolAdapter } from "./openai.js";
import { listPublicProxyModels } from "./passthrough.js";
import { proxyProtocolEndpoint } from "./protocol-endpoint.js";
import type {
  ApiProxyEndpointName,
  ApiProxyProtocolOperation,
  ApiProxyProtocolTransport,
} from "./protocol.js";
import { apiProxyRequestGate } from "./sources.js";

function protocolOperation(input: {
  protocol: ApiProxyProtocolOperation["protocol"];
  endpoint: ApiProxyEndpointName;
  routePath: string;
  transport?: ApiProxyProtocolTransport;
}): ApiProxyProtocolOperation {
  return {
    protocol: input.protocol,
    endpoint: input.endpoint,
    routePath: input.routePath,
    transport: input.transport ?? "http-json",
  };
}

export function registerOpenAiProxyRoutes(app: Hono, prefix: string) {
  app.get(`${prefix}/models`, async (c) => {
    const { rejection } = apiProxyRequestGate(c.req.raw.headers);
    if (rejection) {
      const response = openAiProtocolAdapter.authError(rejection);
      return c.json(response.body, response.status);
    }
    const models = await listPublicProxyModels();
    const statuses = await getApiProxyPublicModelStatuses(models);
    return c.json(openAiModelsList(models, statuses));
  });

  app.post(`${prefix}/chat/completions`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "chat.completions",
        routePath: `${prefix}/chat/completions`,
      }),
    ),
  );
  app.post(`${prefix}/completions`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "completions",
        routePath: `${prefix}/completions`,
      }),
    ),
  );
  app.post(`${prefix}/embeddings`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "embeddings",
        routePath: `${prefix}/embeddings`,
      }),
    ),
  );
  app.post(`${prefix}/rerank`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "rerank",
        routePath: `${prefix}/rerank`,
      }),
    ),
  );
  app.post(`${prefix}/reranking`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "rerank",
        routePath: `${prefix}/reranking`,
      }),
    ),
  );
  app.post(`${prefix}/responses`, (c) =>
    proxyProtocolEndpoint(
      c,
      openAiProtocolAdapter,
      protocolOperation({
        protocol: "openai",
        endpoint: "responses",
        routePath: `${prefix}/responses`,
      }),
    ),
  );
}

export function registerAnthropicProxyRoutes(app: Hono, prefix: string) {
  app.post(`${prefix}/messages`, (c) =>
    proxyProtocolEndpoint(
      c,
      anthropicProtocolAdapter,
      protocolOperation({
        protocol: "anthropic",
        endpoint: "messages",
        routePath: `${prefix}/messages`,
      }),
    ),
  );
  app.post(`${prefix}/messages/count_tokens`, (c) =>
    proxyProtocolEndpoint(
      c,
      anthropicProtocolAdapter,
      protocolOperation({
        protocol: "anthropic",
        endpoint: "messages.count_tokens",
        routePath: `${prefix}/messages/count_tokens`,
      }),
    ),
  );
}
