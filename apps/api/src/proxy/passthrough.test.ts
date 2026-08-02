import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import {
  apiEndpointModelFilterAdmits,
  type ApiEndpointCreate,
} from "@arriero/core";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint } from "./endpoints.js";
import { externalEndpointTarget } from "./external-target.js";
import { resolvePassthroughModel } from "./passthrough.js";
import type { ApiProxyProtocolOperation } from "./protocol.js";
import { resolveApiProxyUpstreamContext } from "./upstream-context.js";

const chatOperation: ApiProxyProtocolOperation = {
  protocol: "openai",
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json",
};

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

function makeEndpoint(
  overrides: Partial<ApiEndpointCreate> & { name: string },
) {
  return createApiEndpoint({
    enabled: true,
    baseUrl: "https://upstream.test/v1",
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    ...overrides,
  });
}

test("an empty filter admits everything", () => {
  assert.equal(apiEndpointModelFilterAdmits(null, "anything/at-all"), true);
});

test("allow globs gate by prefix", () => {
  const filter = { allow: ["anthropic/*", "openai/*"] };
  assert.equal(apiEndpointModelFilterAdmits(filter, "anthropic/claude"), true);
  assert.equal(apiEndpointModelFilterAdmits(filter, "meta/llama"), false);
});

test("deny globs win over allow", () => {
  const filter = { allow: ["anthropic/*"], deny: ["*-beta"] };
  assert.equal(apiEndpointModelFilterAdmits(filter, "anthropic/claude"), true);
  assert.equal(
    apiEndpointModelFilterAdmits(filter, "anthropic/claude-beta"),
    false,
  );
});

test("resolvePassthroughModel routes a bare id to the passthrough endpoint", () => {
  const endpoint = makeEndpoint({ name: "openrouter", passthrough: true });
  const model = resolvePassthroughModel("anthropic/claude-3.5-sonnet");
  assert.ok(model);
  assert.equal(model.modelId, "anthropic/claude-3.5-sonnet");
  assert.equal(model.routeTo?.type, "endpoint");
  assert.equal(
    model.routeTo?.type === "endpoint" ? model.routeTo.endpointId : null,
    endpoint.id,
  );
  assert.equal(
    model.routeTo?.type === "endpoint" ? model.routeTo.upstreamModel : null,
    "anthropic/claude-3.5-sonnet",
  );
});

test("non-passthrough endpoints never resolve dynamically", () => {
  makeEndpoint({ name: "plain", passthrough: false });
  assert.equal(resolvePassthroughModel("anthropic/claude"), null);
});

test("the model filter excludes denied ids from passthrough resolution", () => {
  makeEndpoint({
    name: "openrouter",
    passthrough: true,
    modelFilter: { allow: ["anthropic/*"] },
  });
  assert.equal(resolvePassthroughModel("openai/gpt-4o"), null);
  assert.ok(resolvePassthroughModel("anthropic/claude"));
});

test("a synthetic endpoint target resolves to the endpoint base URL, auth and model override", () => {
  const endpoint = makeEndpoint({
    name: "openrouter",
    passthrough: true,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or",
  });
  const target = externalEndpointTarget({
    endpointId: endpoint.id,
    upstreamModel: "anthropic/claude-3.5-sonnet",
    name: "anthropic/claude-3.5-sonnet",
  });

  const resolved = resolveApiProxyUpstreamContext({
    target,
    operation: chatOperation,
  });
  assert.ok(resolved.ok);
  assert.equal(resolved.context.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(resolved.context.authHeaders.authorization, "Bearer sk-or");
  assert.equal(target.model, "anthropic/claude-3.5-sonnet");
});
