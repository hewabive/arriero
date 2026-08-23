import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetInstancesCache } from "../instances/config-files.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  migrateModelReasoningToUpstreams,
  modelsFileHasReasoningOverrides,
} from "./model-reasoning-migration.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  rmSync(config.instancesDir, { recursive: true, force: true });
  mkdirSync(config.instancesDir, { recursive: true });
  resetConfigFilesCache();
  resetInstancesCache();
});

const qwen38 = { kind: "preset", preset: "qwen3.8" };

function writeProxyFile(name: string, records: unknown[]) {
  writeFileSync(
    resolve(config.proxyConfigDir, name),
    `${JSON.stringify(records, null, 2)}\n`,
    "utf8",
  );
}

function readProxyFile(name: string): Record<string, unknown>[] {
  return JSON.parse(
    readFileSync(resolve(config.proxyConfigDir, name), "utf8"),
  ) as Record<string, unknown>[];
}

function writeInstanceFile(name: string, record: Record<string, unknown>) {
  writeFileSync(
    resolve(config.instancesDir, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

function readInstanceFile(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(config.instancesDir, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function model(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "model-1",
    modelId: "public-model",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
    blockedMessage: "",
    reasoning: null,
    ...overrides,
  };
}

test("a target-routed override moves onto the routed instance", () => {
  writeInstanceFile("qwen", { name: "qwen", kind: "llama-server" });
  writeProxyFile("targets.json", [
    { id: "t1", name: "qwen-target", endpointId: "instance:qwen" },
  ]);
  writeProxyFile("models.json", [
    model({ reasoning: qwen38, routeTo: { type: "target", id: "t1" } }),
  ]);
  assert.equal(modelsFileHasReasoningOverrides(), true);

  migrateModelReasoningToUpstreams();

  assert.equal(modelsFileHasReasoningOverrides(), false);
  assert.deepEqual(readInstanceFile("qwen")["reasoning"], qwen38);
  const [record] = readProxyFile("models.json");
  assert.equal("reasoning" in (record ?? {}), false);
});

test("an endpoint-routed override moves onto the stored endpoint", () => {
  writeProxyFile("endpoints.json", [
    { id: "ep1", name: "external", baseUrl: "https://x.test/v1" },
  ]);
  writeProxyFile("models.json", [
    model({
      reasoning: qwen38,
      routeTo: { type: "endpoint", endpointId: "ep1", upstreamModel: null },
    }),
  ]);

  migrateModelReasoningToUpstreams();

  const [endpoint] = readProxyFile("endpoints.json");
  assert.deepEqual(endpoint?.["reasoning"], qwen38);
  assert.equal(modelsFileHasReasoningOverrides(), false);
});

test("a legacy targetId binding resolves through targets.json", () => {
  writeInstanceFile("legacy", { name: "legacy", kind: "llama-server" });
  writeProxyFile("targets.json", [
    { id: "t2", name: "legacy-target", endpointId: "instance:legacy" },
  ]);
  writeProxyFile("models.json", [model({ reasoning: qwen38, targetId: "t2" })]);

  migrateModelReasoningToUpstreams();

  assert.deepEqual(readInstanceFile("legacy")["reasoning"], qwen38);
});

test("unresolvable and conflicting overrides are dropped, keys stripped", () => {
  writeInstanceFile("taken", {
    name: "taken",
    kind: "llama-server",
    reasoning: { kind: "preset", preset: "gpt-oss" },
  });
  writeProxyFile("targets.json", [
    { id: "t3", name: "taken-target", endpointId: "instance:taken" },
  ]);
  writeProxyFile("models.json", [
    model({
      id: "m-pipeline",
      reasoning: qwen38,
      routeTo: { type: "pipeline", id: "p1" },
    }),
    model({ id: "m-unbound", reasoning: qwen38 }),
    model({
      id: "m-conflict",
      reasoning: qwen38,
      routeTo: { type: "target", id: "t3" },
    }),
  ]);

  migrateModelReasoningToUpstreams();

  assert.equal(modelsFileHasReasoningOverrides(), false);
  assert.deepEqual(readInstanceFile("taken")["reasoning"], {
    kind: "preset",
    preset: "gpt-oss",
  });
  for (const record of readProxyFile("models.json")) {
    assert.equal("reasoning" in record, false);
  }
});

test("null reasoning keys are stripped without touching upstreams", () => {
  writeProxyFile("models.json", [model({})]);
  assert.equal(modelsFileHasReasoningOverrides(), true);

  migrateModelReasoningToUpstreams();

  assert.equal(modelsFileHasReasoningOverrides(), false);
});
