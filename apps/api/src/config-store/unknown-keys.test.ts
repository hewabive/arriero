import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import type { InstanceConfigRecord } from "@arriero/core";

import {
  createCustomBenchmarkPrompt,
  updateCustomBenchmarkPrompt,
} from "../benchmark/custom-prompts.js";
import { getBuildSettings, saveBuildSettings } from "../build/repository.js";
import { config } from "../config.js";
import {
  getInstanceRecord,
  writeInstanceRecord,
} from "../instances/config-files.js";
import {
  createApiProxySource,
  updateApiProxySource,
} from "../proxy/sources.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { readSettings } from "../settings/store.js";
import { resetAllConfigStores } from "./registry.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function injectKey(path: string, mutate: (parsed: unknown) => void): void {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  mutate(parsed);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  resetAllConfigStores();
}

test("settings.json keeps unknown sections and section keys across writes", () => {
  readSettings();
  injectKey(config.settingsFile, (parsed) => {
    const file = parsed as Record<string, unknown>;
    file.futureSection = { marker: 1 };
    file.downloads = { connections: 4, futureKnob: true };
  });
  saveHfDownloadSettings({
    connections: 5,
    chunkBytes: 32 * 1024 * 1024,
    maxEtaHours: 24,
  });
  const written = readJson(config.settingsFile);
  assert.deepEqual(written.futureSection, { marker: 1 });
  const downloads = written.downloads as Record<string, unknown>;
  assert.equal(downloads.futureKnob, true);
  assert.equal(downloads.connections, 5);
});

test("build settings never persist repoPath into settings.json", () => {
  const current = getBuildSettings();
  saveBuildSettings(current);
  const written = readJson(config.settingsFile);
  const build = written.build as Record<string, unknown>;
  assert.ok(build);
  assert.equal("repoPath" in build, false);
});

test("proxy source records keep unknown keys through an update", () => {
  const created = createApiProxySource({
    name: "unknown-keys-source",
    enabled: true,
    note: "",
    blockedMessage: "",
  });
  const sourcesFile = resolve(config.proxyConfigDir, "sources.json");
  injectKey(sourcesFile, (parsed) => {
    const records = parsed as Record<string, unknown>[];
    const record = records.find((item) => item.id === created.id);
    assert.ok(record);
    record.futureField = "kept";
  });
  updateApiProxySource(created.id, { name: "unknown-keys-source-renamed" });
  const written = JSON.parse(readFileSync(sourcesFile, "utf8")) as Record<
    string,
    unknown
  >[];
  const record = written.find((item) => item.id === created.id);
  assert.ok(record);
  assert.equal(record.futureField, "kept");
  assert.equal(record.name, "unknown-keys-source-renamed");
});

test("instance records keep unknown keys through a rewrite", () => {
  const record: InstanceConfigRecord = {
    name: "unknown-keys-instance",
    kind: "llama-server",
    binaryPath: "/opt/llama/bin/llama-server",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
  };
  writeInstanceRecord(record);
  const filePath = resolve(config.instancesDir, "unknown-keys-instance.json");
  injectKey(filePath, (parsed) => {
    (parsed as Record<string, unknown>).futureField = 7;
  });
  const loaded = getInstanceRecord("unknown-keys-instance");
  assert.ok(loaded);
  writeInstanceRecord({ ...loaded, env: { A: "1" } });
  const written = readJson(filePath);
  assert.equal(written.futureField, 7);
  assert.deepEqual(written.env, { A: "1" });
});

test("benchmark prompts keep unknown keys through an update", () => {
  createCustomBenchmarkPrompt({
    id: "unknown-keys-prompt",
    title: "Unknown keys",
    topic: "test",
    language: "en",
    prefillClass: "short",
    maxTokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });
  const promptsFile = resolve(config.configDir, "benchmark", "prompts.json");
  injectKey(promptsFile, (parsed) => {
    const records = parsed as Record<string, unknown>[];
    const record = records.find((item) => item.id === "unknown-keys-prompt");
    assert.ok(record);
    record.futureField = true;
  });
  const updated = updateCustomBenchmarkPrompt("unknown-keys-prompt", {
    title: "Unknown keys kept",
  });
  assert.ok(updated);
  const written = JSON.parse(readFileSync(promptsFile, "utf8")) as Record<
    string,
    unknown
  >[];
  const record = written.find((item) => item.id === "unknown-keys-prompt");
  assert.ok(record);
  assert.equal(record.futureField, true);
  assert.equal(record.title, "Unknown keys kept");
});
