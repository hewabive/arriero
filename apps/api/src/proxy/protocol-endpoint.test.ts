import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { Hono } from "hono";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { registerOpenAiProxyRoutes } from "./protocol-routes.js";
import { createApiProxyModel } from "./repository.js";
import { apiProxyStats } from "./stats.js";
import {
  clearApiProxyTraceHistory,
  listApiProxyTraces,
} from "./traces-repository.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  apiProxyStats.reset();
  clearApiProxyTraceHistory();
});

function seedModel(modelId: string, enabled: boolean) {
  return createApiProxyModel({
    modelId,
    visible: true,
    enabled,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
  });
}

function buildApp(): Hono {
  const app = new Hono();
  registerOpenAiProxyRoutes(app, "/v1");
  return app;
}

async function postChatCompletion(
  app: Hono,
  modelId: string,
): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

test("a disabled model failure persists its diagnostic code on the trace", async () => {
  seedModel("disabled-model", false);

  const response = await postChatCompletion(buildApp(), "disabled-model");
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "arriero_proxy_model_disabled");

  const traces = listApiProxyTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.errorCode, "arriero_proxy_model_disabled");
  assert.equal(traces[0]?.errorMessage, "Model disabled-model is disabled");
  assert.equal(traces[0]?.ok, false);
  assert.equal(traces[0]?.status, 503);
});

test("an unbound model failure persists its route diagnostic code", async () => {
  seedModel("unbound-model", true);

  const response = await postChatCompletion(buildApp(), "unbound-model");
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "arriero_proxy_route_unbound");

  const traces = listApiProxyTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.errorCode, "arriero_proxy_route_unbound");
  assert.equal(traces[0]?.ok, false);
});
