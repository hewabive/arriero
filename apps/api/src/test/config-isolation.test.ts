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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routeTest = "src/routes/environments.routes.test.ts";
const sentinel = '{"sentinel":"untouched"}\n';

const scenarioRoots: string[] = [];

after(() => {
  for (const root of scenarioRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scenarioRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scenarioRoots.push(root);
  return root;
}

function isolatedEnvironment(testRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARRIERO_HOME: join(testRoot, "manager"),
    ARRIERO_DATA_DIR: join(testRoot, "data"),
    ARRIERO_CONFIG_DIR: join(testRoot, "data", "config"),
    ARRIERO_RUNTIME_DIR: join(testRoot, "runtime"),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function seedSentinel(configDir: string): string {
  const settingsFile = join(configDir, "settings.json");
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, sentinel, "utf8");
  return settingsFile;
}

function runRouteTest(
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", routeTest],
      { cwd: apiDir, env, timeout: 15_000 },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolveRun({ status: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (status) => {
      resolveRun({ status, output });
    });
  });
}

const refusalEnv = isolatedEnvironment(
  scenarioRoot("arriero-isolation-probe-"),
);
delete refusalEnv.ARRIERO_TEST_ROOT;
const refusalSentinelFile = seedSentinel(refusalEnv.ARRIERO_CONFIG_DIR!);
const refusalRun = runRouteTest(refusalEnv);

const isolatedRoot = scenarioRoot("arriero-isolation-probe-");
const isolatedEnv = isolatedEnvironment(isolatedRoot);
isolatedEnv.ARRIERO_TEST_ROOT = isolatedRoot;
const isolatedRun = runRouteTest(isolatedEnv);

const escapeRoot = scenarioRoot("arriero-isolation-probe-");
const escapeEnv = isolatedEnvironment(escapeRoot);
escapeEnv.ARRIERO_TEST_ROOT = escapeRoot;
escapeEnv.ARRIERO_CONFIG_DIR = join(
  scenarioRoot("arriero-outside-probe-"),
  "config",
);
const escapeSentinelFile = seedSentinel(escapeEnv.ARRIERO_CONFIG_DIR);
const escapeRun = runRouteTest(escapeEnv);

test("a direct API test run refuses to load mutable paths without the test bootstrap", async () => {
  const result = await refusalRun;
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /Refusing to load Arriero paths from a test process without ARRIERO_TEST_ROOT/,
  );
  assert.equal(readFileSync(refusalSentinelFile, "utf8"), sentinel);
});

test("the API test bootstrap may write only below its dedicated test root", async () => {
  const result = await isolatedRun;
  assert.equal(result.status, 0, result.output);
  assert.match(
    readFileSync(
      join(isolatedEnv.ARRIERO_CONFIG_DIR!, "settings.json"),
      "utf8",
    ),
    /"environments"/,
  );
});

test("the test bootstrap rejects a mutable path outside its test root", async () => {
  const result = await escapeRun;
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /ARRIERO_CONFIG_DIR must stay inside ARRIERO_TEST_ROOT/,
  );
  assert.equal(readFileSync(escapeSentinelFile, "utf8"), sentinel);
});
