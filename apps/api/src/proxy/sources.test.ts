import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  apiProxyRequestSourceRejection,
  createApiProxySource,
  deleteApiProxySource,
  extractRequestApiKey,
  resolveApiProxyRequestSource,
  updateApiProxySource,
} from "./sources.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

test("keeps the API key out of sources.json and resolves by key", () => {
  const source = createApiProxySource({
    name: "cline",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "sk-cline",
  });
  assert.equal(source.keyConfigured, true);

  const resolved = resolveApiProxyRequestSource("sk-cline");
  assert.deepEqual(resolved, {
    kind: "source",
    id: source.id,
    name: "cline",
    enabled: true,
    blockedMessage: "",
  });
});

test("missing key resolves to anonymous, unmatched key to unknown", () => {
  createApiProxySource({
    name: "a",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "k1",
  });
  assert.deepEqual(resolveApiProxyRequestSource(null), { kind: "anonymous" });
  assert.deepEqual(resolveApiProxyRequestSource("nope"), { kind: "unknown" });
});

test("a disabled source still resolves, carrying its blocked message", () => {
  const source = createApiProxySource({
    name: "a",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "k1",
  });
  updateApiProxySource(source.id, {
    enabled: false,
    blockedMessage: "Contact the admin.",
  });
  assert.deepEqual(resolveApiProxyRequestSource("k1"), {
    kind: "source",
    id: source.id,
    name: "a",
    enabled: false,
    blockedMessage: "Contact the admin.",
  });
});

function policy(allowAnonymous: boolean) {
  return {
    allowAnonymous,
    anonymousBlockedMessage: "",
    unknownKeyBlockedMessage: "",
  };
}

test("rejection: disabled source gets 423 regardless of anonymous policy", () => {
  const resolution = {
    kind: "source",
    id: "x",
    name: "a",
    enabled: false,
    blockedMessage: "Contact the admin.",
  } as const;
  for (const allowAnonymous of [true, false]) {
    const rejection = apiProxyRequestSourceRejection(
      resolution,
      policy(allowAnonymous),
    );
    assert.equal(rejection?.status, 423);
    assert.equal(rejection?.code, "arriero_proxy_source_disabled");
    assert.equal(rejection?.message, "Contact the admin.");
  }
});

test("rejection: disabled source without a custom message gets the default", () => {
  const rejection = apiProxyRequestSourceRejection(
    { kind: "source", id: "x", name: "a", enabled: false, blockedMessage: "" },
    policy(true),
  );
  assert.equal(rejection?.status, 423);
  assert.match(rejection?.message ?? "", /disabled by the administrator/);
});

test("rejection: anonymous and unknown pass when anonymous is allowed", () => {
  assert.equal(
    apiProxyRequestSourceRejection({ kind: "anonymous" }, policy(true)),
    null,
  );
  assert.equal(
    apiProxyRequestSourceRejection({ kind: "unknown" }, policy(true)),
    null,
  );
  assert.equal(
    apiProxyRequestSourceRejection(
      { kind: "source", id: "x", name: "a", enabled: true, blockedMessage: "" },
      policy(false),
    ),
    null,
  );
});

test("rejection: anonymous and unknown get 423 when anonymous is denied", () => {
  const anonymous = apiProxyRequestSourceRejection(
    { kind: "anonymous" },
    policy(false),
  );
  assert.equal(anonymous?.status, 423);
  assert.equal(anonymous?.code, "arriero_proxy_source_required");
  assert.match(anonymous?.message ?? "", /Anonymous requests are disabled/);

  const unknown = apiProxyRequestSourceRejection(
    { kind: "unknown" },
    policy(false),
  );
  assert.equal(unknown?.status, 423);
  assert.equal(unknown?.code, "invalid_api_key");
  assert.match(unknown?.message ?? "", /Unknown API key/);
});

test("rejection: anonymous and unknown carry the admin-set messages", () => {
  const denied = {
    allowAnonymous: false,
    anonymousBlockedMessage: "Ask the admin for a key.",
    unknownKeyBlockedMessage: "This key is not registered.",
  };
  assert.equal(
    apiProxyRequestSourceRejection({ kind: "anonymous" }, denied)?.message,
    "Ask the admin for a key.",
  );
  assert.equal(
    apiProxyRequestSourceRejection({ kind: "unknown" }, denied)?.message,
    "This key is not registered.",
  );
});

test("rejects assigning a key already used by another source", () => {
  createApiProxySource({
    name: "a",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "dup",
  });
  assert.throws(() =>
    createApiProxySource({
      name: "b",
      enabled: true,
      note: "",
      blockedMessage: "",
      apiKey: "dup",
    }),
  );
});

test("update without apiKey keeps the stored key", () => {
  const source = createApiProxySource({
    name: "a",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "k1",
  });
  updateApiProxySource(source.id, { note: "edited" });
  assert.deepEqual(resolveApiProxyRequestSource("k1"), {
    kind: "source",
    id: source.id,
    name: "a",
    enabled: true,
    blockedMessage: "",
  });
});

test("deleting a source drops its key", () => {
  const source = createApiProxySource({
    name: "a",
    enabled: true,
    note: "",
    blockedMessage: "",
    apiKey: "k1",
  });
  deleteApiProxySource(source.id);
  assert.deepEqual(resolveApiProxyRequestSource("k1"), { kind: "unknown" });
});

test("extractRequestApiKey reads x-api-key and Bearer", () => {
  assert.equal(
    extractRequestApiKey(new Headers({ "x-api-key": "abc" })),
    "abc",
  );
  assert.equal(
    extractRequestApiKey(new Headers({ authorization: "Bearer xyz" })),
    "xyz",
  );
  assert.equal(extractRequestApiKey(new Headers({})), null);
});
