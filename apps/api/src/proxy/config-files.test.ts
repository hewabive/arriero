import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetConfigFilesCache, readSecret } from "./config-files.js";
import {
  createApiProxyModel,
  createApiProxyQuickRoute,
  createApiProxyTarget,
  deleteApiProxyTarget,
  getApiProxyModel,
  getApiProxyModelByModelId,
  getApiProxyRuntimeMetadata,
  listApiProxyTargets,
  setApiProxyRuntimeMetadata,
} from "./repository.js";
import { createApiEndpoint, getExternalApiEndpoint } from "./endpoints.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

function seedModel(modelId: string, targetId: string | null) {
  return createApiProxyModel({
    modelId,
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId,
    routeTo: null,
    description: null,
    blockedMessage: "",
  });
}

function seedTarget(name: string) {
  return createApiProxyTarget({
    name,
    endpointId: "external:test",
    model: null,
    role: "background",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: true,
    slotIds: [0],
    idleUnloadMs: null,
  });
}

test("create persists a target to targets.json", () => {
  const target = seedTarget("alpha");
  const raw = JSON.parse(
    readFileSync(`${config.proxyConfigDir}/targets.json`, "utf8"),
  ) as Array<{ id: string; name: string }>;
  assert.equal(raw.length, 1);
  assert.equal(raw[0]?.id, target.id);
  assert.equal(raw[0]?.name, "alpha");
});

test("targets.json keeps entries sorted by name", () => {
  seedTarget("zulu");
  seedTarget("alpha");
  seedTarget("mike");
  const raw = JSON.parse(
    readFileSync(`${config.proxyConfigDir}/targets.json`, "utf8"),
  ) as Array<{ name: string }>;
  assert.deepEqual(
    raw.map((item) => item.name),
    ["alpha", "mike", "zulu"],
  );
});

test("duplicate target name is rejected", () => {
  seedTarget("dup");
  assert.throws(() => seedTarget("dup"), /already exists/);
});

test("duplicate model id is rejected", () => {
  seedModel("shared", null);
  assert.throws(() => seedModel("shared", null), /already exists/);
});

test("deleting a target nulls referencing models and drops runtime metadata", () => {
  const target = seedTarget("with-refs");
  const model = seedModel("bound", target.id);
  setApiProxyRuntimeMetadata(target.id, { savedSlotIds: [0] });

  assert.equal(deleteApiProxyTarget(target.id), true);
  assert.equal(getApiProxyModel(model.id)?.targetId, null);
  assert.equal(getApiProxyRuntimeMetadata(target.id), null);
});

test("quick route creates a target and an enabled model bound to it", () => {
  const result = createApiProxyQuickRoute({
    targetName: "quick",
    endpointId: "external:test",
    model: null,
    modelId: "quick-model",
  });

  assert.equal(result.target.name, "quick");
  assert.equal(result.model.modelId, "quick-model");
  assert.equal(result.model.enabled, true);
  assert.equal(result.model.targetId, result.target.id);
  assert.deepEqual(result.model.routeTo, {
    type: "target",
    id: result.target.id,
  });
});

test("quick route with a taken model id leaves no orphan target", () => {
  seedModel("taken", null);
  assert.throws(
    () =>
      createApiProxyQuickRoute({
        targetName: "orphan",
        endpointId: "external:test",
        model: null,
        modelId: "taken",
      }),
    /already exists/,
  );
  assert.equal(
    listApiProxyTargets().some((target) => target.name === "orphan"),
    false,
  );
});

test("quick route with a taken target name creates no model", () => {
  seedTarget("dup-target");
  assert.throws(
    () =>
      createApiProxyQuickRoute({
        targetName: "dup-target",
        endpointId: "external:test",
        model: null,
        modelId: "fresh-model",
      }),
    /already exists/,
  );
  assert.equal(getApiProxyModelByModelId("fresh-model"), null);
});

test("endpoint api key is stored in secrets, never in endpoints.json", () => {
  const endpoint = createApiEndpoint({
    name: "external-secret",
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    apiKey: "sk-secret-value",
  });

  const rawEndpoints = readFileSync(
    `${config.proxyConfigDir}/endpoints.json`,
    "utf8",
  );
  assert.ok(!rawEndpoints.includes("sk-secret-value"));
  assert.ok(!rawEndpoints.includes('"apiKey"'));
  assert.equal(readSecret(endpoint.id), "sk-secret-value");
  assert.equal(getExternalApiEndpoint(endpoint.id)?.authConfigured, true);
});
