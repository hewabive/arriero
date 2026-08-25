import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  getArgumentDefaults,
  resetArgumentDefaultsCache,
} from "./arguments/defaults-repository.js";
import { config } from "./config.js";
import { normalizeConfigFiles } from "./config-normalize.js";
import {
  listInstanceRecords,
  resetInstancesCache,
} from "./instances/config-files.js";
import {
  PATH_CATALOG_FILE,
  listPathCatalogEntries,
  resetPathCatalogCache,
} from "./path-catalog/repository.js";
import { resetConfigFilesCache } from "./proxy/config-files.js";
import { readSettings, resetSettingsCache } from "./settings/store.js";

const binaryPath = resolve(config.buildsDir, "master/bin/llama-server");
const modelPath = resolve(config.modelsDir, "demo/model.gguf");
const instanceFile = resolve(config.instancesDir, "demo.json");
const targetsFile = resolve(config.proxyConfigDir, "targets.json");

function writeJson(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedAbsolutePathConfig() {
  writeJson(config.settingsFile, {
    modelScan: { directory: config.modelsDir, maxDepth: 4 },
    build: {
      buildDir: config.buildsDir,
      buildType: "Release",
      cuda: false,
      native: true,
      extraCmakeArgs: [],
      target: "llama-server",
      parallelJobs: null,
    },
  });
  writeJson(config.argumentDefaultsFile, {
    instance: [{ key: "--model", value: modelPath, valueType: "string" }],
  });
  writeJson(PATH_CATALOG_FILE, [
    {
      id: "01",
      kind: "binary",
      name: "llama-server",
      path: binaryPath,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ]);
  writeJson(instanceFile, {
    name: "demo",
    kind: "llama-server",
    binaryPath,
    binaryPathRefId: "01",
    args: { "--model": modelPath, "--port": 5190 },
    env: { LD_LIBRARY_PATH: resolve(config.buildsDir, "master/lib") },
  });
  resetInstancesCache();
  resetPathCatalogCache();
  resetSettingsCache();
  resetArgumentDefaultsCache();
}

function cleanup() {
  rmSync(instanceFile, { force: true });
  rmSync(PATH_CATALOG_FILE, { force: true });
  rmSync(config.settingsFile, { force: true });
  rmSync(config.argumentDefaultsFile, { force: true });
  rmSync(targetsFile, { force: true });
  resetInstancesCache();
  resetPathCatalogCache();
  resetConfigFilesCache();
  resetSettingsCache();
  resetArgumentDefaultsCache();
}

test("rewrites stored absolute paths as placeholders and keeps reads absolute", (t) => {
  t.after(cleanup);
  seedAbsolutePathConfig();

  assert.deepEqual(normalizeConfigFiles().sort(), [
    "argument-defaults.json",
    "instances/demo.json",
    "path-catalog.json",
    "settings.json",
  ]);
  assert.deepEqual(normalizeConfigFiles(), []);

  const instanceRaw = readFileSync(instanceFile, "utf8");
  assert.match(
    instanceRaw,
    /"binaryPath": "\$\{ARRIERO_BUILDS_DIR\}\/master\/bin\/llama-server"/,
  );
  assert.equal(instanceRaw.includes(config.runtimeDir), false);
  assert.equal(
    readFileSync(PATH_CATALOG_FILE, "utf8").includes(config.runtimeDir),
    false,
  );
  assert.equal(
    readFileSync(config.settingsFile, "utf8").includes(config.runtimeDir),
    false,
  );

  resetInstancesCache();
  resetPathCatalogCache();
  const record = listInstanceRecords().find((item) => item.name === "demo");
  assert.equal(record?.binaryPath, binaryPath);
  assert.equal(record?.args["--model"], modelPath);
  assert.equal(listPathCatalogEntries()[0]?.path, binaryPath);
  assert.equal(readSettings().build?.buildDir, config.buildsDir);
  assert.equal(getArgumentDefaults().instance[0]?.value, modelPath);
});

test("strips legacy createdAt/updatedAt from tracked config files", (t) => {
  t.after(cleanup);
  writeJson(config.settingsFile, {
    sourceRepositories: [
      {
        id: "llama-cpp",
        adapter: "llama-cpp",
        originUrl: "https://github.com/ggml-org/llama.cpp",
        location: { type: "managed" },
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  });
  writeJson(instanceFile, {
    name: "demo",
    kind: "llama-server",
    binaryPath: "${ARRIERO_BUILDS_DIR}/master/bin/llama-server",
    args: {},
    env: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  writeJson(targetsFile, [
    {
      id: "t1",
      name: "alpha",
      endpointId: "external:test",
      model: null,
      role: "background",
      priority: 100,
      preemptible: true,
      saveSlotsBeforeUnload: false,
      slotIds: [],
      idleUnloadMs: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ]);
  writeJson(PATH_CATALOG_FILE, [
    {
      id: "01",
      kind: "binary",
      name: "llama-server",
      path: "${ARRIERO_BUILDS_DIR}/master/bin/llama-server",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ]);
  resetInstancesCache();
  resetPathCatalogCache();
  resetConfigFilesCache();

  assert.deepEqual(normalizeConfigFiles().sort(), [
    "instances/demo.json",
    "proxy/targets.json",
    "settings.json",
  ]);
  assert.deepEqual(normalizeConfigFiles(), []);

  for (const path of [config.settingsFile, instanceFile, targetsFile]) {
    const raw = readFileSync(path, "utf8");
    assert.equal(raw.includes("createdAt"), false, path);
    assert.equal(raw.includes("updatedAt"), false, path);
  }
  assert.match(readFileSync(PATH_CATALOG_FILE, "utf8"), /"createdAt"/);
});

test("rewrites placeholders that are no longer canonical", (t) => {
  t.after(cleanup);
  writeJson(config.settingsFile, {
    modelScan: {
      directory: "${ARRIERO_RUNTIME_DIR}/models",
      maxDepth: 4,
    },
  });
  writeJson(instanceFile, {
    name: "demo",
    kind: "llama-server",
    binaryPath: "${ARRIERO_RUNTIME_DIR}/builds/master/bin/llama-server",
    args: {},
    env: {},
  });
  resetInstancesCache();
  resetSettingsCache();

  assert.deepEqual(normalizeConfigFiles().sort(), [
    "instances/demo.json",
    "settings.json",
  ]);
  assert.deepEqual(normalizeConfigFiles(), []);

  assert.match(
    readFileSync(instanceFile, "utf8"),
    /"binaryPath": "\$\{ARRIERO_BUILDS_DIR\}\/master\/bin\/llama-server"/,
  );
  assert.match(
    readFileSync(config.settingsFile, "utf8"),
    /"directory": "\$\{ARRIERO_MODELS_DIR\}"/,
  );
});

test("leaves absolute paths in non-portable files untouched", (t) => {
  t.after(cleanup);
  writeJson(targetsFile, [
    {
      id: "t1",
      name: binaryPath,
      endpointId: "external:test",
      model: null,
      role: "background",
      priority: 100,
      preemptible: true,
      saveSlotsBeforeUnload: false,
      slotIds: [],
      idleUnloadMs: null,
    },
  ]);
  resetConfigFilesCache();

  assert.deepEqual(normalizeConfigFiles(), []);
  assert.ok(readFileSync(targetsFile, "utf8").includes(binaryPath));
});

test("survives an application directory rename", (t) => {
  t.after(() => {
    cleanup();
    config.runtimeDir = originalRuntimeDir;
    config.buildsDir = originalBuildsDir;
    config.modelsDir = originalModelsDir;
  });
  const originalRuntimeDir = config.runtimeDir;
  const originalBuildsDir = config.buildsDir;
  const originalModelsDir = config.modelsDir;

  seedAbsolutePathConfig();
  normalizeConfigFiles();

  const movedRuntimeDir = resolve(originalRuntimeDir, "..", "runtime-moved");
  config.runtimeDir = movedRuntimeDir;
  config.buildsDir = resolve(movedRuntimeDir, "builds");
  config.modelsDir = resolve(movedRuntimeDir, "models");
  resetInstancesCache();
  resetPathCatalogCache();
  resetSettingsCache();

  const record = listInstanceRecords().find((item) => item.name === "demo");
  assert.equal(
    record?.binaryPath,
    resolve(movedRuntimeDir, "builds/master/bin/llama-server"),
  );
  assert.equal(
    listPathCatalogEntries()[0]?.path,
    resolve(movedRuntimeDir, "builds/master/bin/llama-server"),
  );
  assert.equal(
    readSettings().build?.buildDir,
    resolve(movedRuntimeDir, "builds"),
  );
});
