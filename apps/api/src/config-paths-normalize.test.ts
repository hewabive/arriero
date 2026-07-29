import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { getArgumentDefaults } from "./arguments/defaults-repository.js";
import { config } from "./config.js";
import {
  configFilesWithAbsolutePaths,
  normalizeConfigPaths,
} from "./config-paths-normalize.js";
import {
  listInstanceRecords,
  resetInstancesCache,
} from "./instances/config-files.js";
import {
  PATH_CATALOG_FILE,
  listPathCatalogEntries,
  resetPathCatalogCache,
} from "./path-catalog/repository.js";
import { readSettings } from "./settings/store.js";

const binaryPath = resolve(config.buildsDir, "master/bin/llama-server");
const modelPath = resolve(config.modelsDir, "demo/model.gguf");
const instanceFile = resolve(config.instancesDir, "demo.json");

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
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  resetInstancesCache();
  resetPathCatalogCache();
}

function cleanup() {
  rmSync(instanceFile, { force: true });
  rmSync(PATH_CATALOG_FILE, { force: true });
  rmSync(config.settingsFile, { force: true });
  rmSync(config.argumentDefaultsFile, { force: true });
  resetInstancesCache();
  resetPathCatalogCache();
}

test("rewrites stored absolute paths as placeholders and keeps reads absolute", (t) => {
  t.after(cleanup);
  seedAbsolutePathConfig();

  assert.deepEqual(normalizeConfigPaths().sort(), [
    "argument-defaults.json",
    "instances/demo.json",
    "path-catalog.json",
    "settings.json",
  ]);
  assert.deepEqual(configFilesWithAbsolutePaths(), []);
  assert.deepEqual(normalizeConfigPaths(), []);

  const instanceRaw = readFileSync(instanceFile, "utf8");
  assert.match(
    instanceRaw,
    /"binaryPath": "\$\{ARRIERO_RUNTIME_DIR\}\/builds\/master\/bin\/llama-server"/,
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
  normalizeConfigPaths();

  const movedRuntimeDir = resolve(originalRuntimeDir, "..", "runtime-moved");
  config.runtimeDir = movedRuntimeDir;
  config.buildsDir = resolve(movedRuntimeDir, "builds");
  config.modelsDir = resolve(movedRuntimeDir, "models");
  resetInstancesCache();
  resetPathCatalogCache();

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
