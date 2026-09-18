import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { getApiProxySettings, updateApiProxySettings } from "./settings.js";
import { createApiEndpoint } from "./endpoints.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

test("defaults to allowing anonymous requests", () => {
  assert.deepEqual(getApiProxySettings(), {
    allowAnonymous: true,
    anonymousBlockedMessage: "",
    unknownKeyBlockedMessage: "",
    streamIdleTimeoutMs: null,
    traceRetentionDays: 30,
    agentSessionEndpointId: null,
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

test("agent session endpoint selection persists, validates references and can be cleared", () => {
  const endpoint = createApiEndpoint({
    name: "rag",
    baseUrl: "http://127.0.0.1:8789/v1",
  });
  updateApiProxySettings({ agentSessionEndpointId: endpoint.id });
  updateApiProxySettings({ allowAnonymous: false });
  resetConfigFilesCache();
  assert.equal(getApiProxySettings().agentSessionEndpointId, endpoint.id);
  assert.throws(
    () => updateApiProxySettings({ agentSessionEndpointId: "missing" }),
    /existing external endpoint/,
  );
  assert.throws(
    () => updateApiProxySettings({ agentSessionEndpointId: "manager-proxy" }),
    /existing external endpoint/,
  );
  assert.equal(getApiProxySettings().agentSessionEndpointId, endpoint.id);
  updateApiProxySettings({ agentSessionEndpointId: null });
  assert.equal(getApiProxySettings().agentSessionEndpointId, null);
});
