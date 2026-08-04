import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routeTest = "src/routes/environments.routes.test.ts";

function isolatedEnvironment(testRoot: string): NodeJS.ProcessEnv {
  const runtimeDir = join(testRoot, "runtime");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARRIERO_HOME: join(testRoot, "manager"),
    ARRIERO_DATA_DIR: join(testRoot, "data"),
    ARRIERO_CONFIG_DIR: join(testRoot, "data", "config"),
    ARRIERO_RUNTIME_DIR: runtimeDir,
    ARRIERO_LOGS_DIR: join(runtimeDir, "logs"),
    ARRIERO_BUILDS_DIR: join(runtimeDir, "builds"),
    ARRIERO_SOURCES_DIR: join(runtimeDir, "sources"),
    ARRIERO_ENVS_DIR: join(runtimeDir, "envs"),
    ARRIERO_PYTHON_DIR: join(runtimeDir, "python"),
    ARRIERO_UV_CACHE_DIR: join(runtimeDir, "uv-cache"),
    ARRIERO_MODELS_DIR: join(runtimeDir, "models"),
    ARRIERO_SLOTS_DIR: join(runtimeDir, "slots"),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function runRouteTest(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "--test", routeTest], {
    cwd: apiDir,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("a direct API test run refuses to load mutable paths without the test bootstrap", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "arriero-isolation-probe-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const env = isolatedEnvironment(testRoot);
  delete env.ARRIERO_TEST_ROOT;
  const settingsFile = join(env.ARRIERO_CONFIG_DIR!, "settings.json");
  const sentinel = '{"sentinel":"untouched"}\n';
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, sentinel, "utf8");

  const result = runRouteTest(env);

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Refusing to load Arriero paths from a test process without ARRIERO_TEST_ROOT/,
  );
  assert.equal(readFileSync(settingsFile, "utf8"), sentinel);
});

test("the API test bootstrap may write only below its dedicated test root", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "arriero-isolation-probe-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const env = isolatedEnvironment(testRoot);
  env.ARRIERO_TEST_ROOT = testRoot;
  const result = runRouteTest(env);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    readFileSync(join(env.ARRIERO_CONFIG_DIR!, "settings.json"), "utf8"),
    /"environments"/,
  );
});

test("the test bootstrap rejects a mutable path outside its test root", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "arriero-isolation-probe-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "arriero-outside-probe-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  const env = isolatedEnvironment(testRoot);
  env.ARRIERO_TEST_ROOT = testRoot;
  env.ARRIERO_CONFIG_DIR = join(outsideRoot, "config");
  const settingsFile = join(env.ARRIERO_CONFIG_DIR, "settings.json");
  const sentinel = '{"sentinel":"untouched"}\n';
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, sentinel, "utf8");

  const result = runRouteTest(env);

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /ARRIERO_CONFIG_DIR must stay inside ARRIERO_TEST_ROOT/,
  );
  assert.equal(readFileSync(settingsFile, "utf8"), sentinel);
});
