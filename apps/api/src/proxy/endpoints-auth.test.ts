import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import type { ApiEndpointCreate } from "@arriero/core";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { apiEndpointAuthHeaders, createApiEndpoint } from "./endpoints.js";

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

test("openai profile sends a stored key as a Bearer token", () => {
  const endpoint = makeEndpoint({ name: "openrouter", apiKey: "sk-1" });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers.authorization, "Bearer sk-1");
});

test("anthropic profile sends a stored key as x-api-key with a version", () => {
  const endpoint = makeEndpoint({
    name: "anthropic",
    profile: "anthropic",
    apiKey: "sk-2",
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers["x-api-key"], "sk-2");
  assert.equal(auth.headers["anthropic-version"], "2023-06-01");
  assert.equal(auth.headers.authorization, undefined);
});

test("an auth header override places the key in a custom header", () => {
  const endpoint = makeEndpoint({
    name: "custom",
    apiKey: "sk-3",
    authHeaderName: "x-custom-key",
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers["x-custom-key"], "sk-3");
  assert.equal(auth.headers.authorization, undefined);
});

test("extra headers are always sent alongside auth", () => {
  const endpoint = makeEndpoint({
    name: "with-headers",
    apiKey: "sk-4",
    extraHeaders: { "HTTP-Referer": "https://app.example" },
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers["HTTP-Referer"], "https://app.example");
  assert.equal(auth.headers.authorization, "Bearer sk-4");
});

test("env var auth reads the key from process.env", () => {
  process.env.TEST_PROXY_KEY = "env-key";
  const endpoint = makeEndpoint({
    name: "env",
    apiKeyEnvVar: "TEST_PROXY_KEY",
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers.authorization, "Bearer env-key");
  delete process.env.TEST_PROXY_KEY;
});

test("a named but unset env var is an error", () => {
  delete process.env.TEST_MISSING_KEY;
  const endpoint = makeEndpoint({
    name: "missing-env",
    apiKeyEnvVar: "TEST_MISSING_KEY",
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.equal(auth.ok, false);
});

test("no key configured is a public endpoint with only extra headers", () => {
  const endpoint = makeEndpoint({
    name: "public",
    extraHeaders: { "X-Title": "app" },
  });
  const auth = apiEndpointAuthHeaders(endpoint.id);
  assert.ok(auth.ok);
  assert.equal(auth.headers.authorization, undefined);
  assert.equal(auth.headers["X-Title"], "app");
});
