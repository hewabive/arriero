import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { getApiProxySettings, updateApiProxySettings } from "./settings.js";

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
  });
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
