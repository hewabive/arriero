import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { registerProxyRoutes } from "../routes/proxy.routes.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint } from "./endpoints.js";
import { getApiProxySettings, updateApiProxySettings } from "./settings.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

test("defaults to allowing anonymous requests", () => {
  assert.deepEqual(getApiProxySettings(), {
    filesEndpointId: null,
    allowAnonymous: true,
    anonymousBlockedMessage: "",
    unknownKeyBlockedMessage: "",
    streamIdleTimeoutMs: null,
    traceRetentionDays: 30,
  });
});

test("persists the trace retention independently of other fields", () => {
  updateApiProxySettings({ traceRetentionDays: 7 });
  assert.equal(getApiProxySettings().traceRetentionDays, 7);

  updateApiProxySettings({ allowAnonymous: false });
  assert.equal(getApiProxySettings().traceRetentionDays, 7);

  resetConfigFilesCache();
  assert.equal(getApiProxySettings().traceRetentionDays, 7);
});

test("persists rejection messages independently of other fields", () => {
  updateApiProxySettings({ anonymousBlockedMessage: "Ask for a key." });
  updateApiProxySettings({ unknownKeyBlockedMessage: "Key not registered." });
  updateApiProxySettings({ allowAnonymous: false });

  resetConfigFilesCache();
  const settings = getApiProxySettings();
  assert.equal(settings.anonymousBlockedMessage, "Ask for a key.");
  assert.equal(settings.unknownKeyBlockedMessage, "Key not registered.");
});

test("persists the stream idle timeout independently of other fields", () => {
  updateApiProxySettings({ streamIdleTimeoutMs: 60_000 });
  assert.equal(getApiProxySettings().streamIdleTimeoutMs, 60_000);

  updateApiProxySettings({ allowAnonymous: false });
  assert.equal(getApiProxySettings().streamIdleTimeoutMs, 60_000);

  updateApiProxySettings({ streamIdleTimeoutMs: null });
  assert.equal(getApiProxySettings().streamIdleTimeoutMs, null);
});

test("persists the anonymous toggle across cache resets", () => {
  updateApiProxySettings({ allowAnonymous: false });
  assert.equal(getApiProxySettings().allowAnonymous, false);

  resetConfigFilesCache();
  assert.equal(getApiProxySettings().allowAnonymous, false);
});

test("update without fields keeps the current value", () => {
  updateApiProxySettings({ allowAnonymous: false });
  updateApiProxySettings({});
  assert.equal(getApiProxySettings().allowAnonymous, false);
});

test("persists and clears the default Files endpoint without resetting other settings", () => {
  updateApiProxySettings({
    filesEndpointId: "files-provider",
    allowAnonymous: false,
  });
  updateApiProxySettings({ traceRetentionDays: 7 });
  resetConfigFilesCache();
  assert.equal(getApiProxySettings().filesEndpointId, "files-provider");
  updateApiProxySettings({ filesEndpointId: null });
  resetConfigFilesCache();
  assert.equal(getApiProxySettings().filesEndpointId, null);
  assert.equal(getApiProxySettings().allowAnonymous, false);
  assert.equal(getApiProxySettings().traceRetentionDays, 7);
});

test("settings API validates the default Files endpoint and allows clearing it", async () => {
  const app = new Hono();
  registerProxyRoutes(app);
  const enabled = createApiEndpoint({
    name: "files",
    baseUrl: "https://files.test/v1",
    profile: "openai",
  });
  const disabled = createApiEndpoint({
    name: "disabled",
    baseUrl: "https://disabled.test/v1",
    profile: "openai",
    enabled: false,
  });
  const anthropic = createApiEndpoint({
    name: "anthropic",
    baseUrl: "https://anthropic.test/v1",
    profile: "anthropic",
  });
  const patch = (filesEndpointId: string | null) =>
    app.request("/api/proxy/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesEndpointId }),
    });
  assert.equal((await patch(enabled.id)).status, 200);
  for (const id of ["missing", "manager-proxy", disabled.id, anthropic.id]) {
    const response = await patch(id);
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error,
      /enabled external OpenAI endpoint/,
    );
    assert.equal(getApiProxySettings().filesEndpointId, enabled.id);
  }
  assert.equal((await patch(null)).status, 200);
  assert.equal(getApiProxySettings().filesEndpointId, null);
});
