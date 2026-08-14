import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import {
  createProcessRun,
  latestProcessRun,
} from "../process/runs-repository.js";
import {
  listQuarantinedInstanceNames,
  resetInstancesCache,
} from "./config-files.js";
import {
  InstanceConfigValidationError,
  InstanceNameConflictError,
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  updateInstance,
} from "./repository.js";

let binaryRefId: string;
let counter = 0;

function uniqueName(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}`;
}

beforeEach(() => {
  resetInstancesCache();
  binaryRefId = createPathCatalogEntry({
    kind: "binary",
    name: uniqueName("bin"),
    path: `/opt/llama/llama-server-${counter}`,
  }).id;
});

test("createInstance writes a file and resolves the binary path", () => {
  const name = uniqueName("inst");
  const created = createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: { "--ctx-size": 4096 },
    env: { CUDA_VISIBLE_DEVICES: "0" },
    memory: [],
  });

  assert.equal(created.name, name);
  assert.match(created.binaryPath, /llama-server-/);
  assert.equal(created.status, "stopped");

  const filePath = resolve(config.instancesDir, `${name}.json`);
  assert.ok(existsSync(filePath));
  const stored = JSON.parse(readFileSync(filePath, "utf8")) as {
    id?: unknown;
    name: string;
    status?: unknown;
    pid?: unknown;
  };
  assert.equal(stored.name, created.name);
  assert.equal("id" in stored, false);
  assert.equal("status" in stored, false);
  assert.equal("pid" in stored, false);
});

test("instance file stores args and env keys sorted", () => {
  const name = uniqueName("sorted");
  createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: { "--port": 8080, "--alias": "m", "--ctx-size": 4096 },
    env: { ZED: "1", ALPHA: "2" },
    memory: [],
  });

  const filePath = resolve(config.instancesDir, `${name}.json`);
  const stored = JSON.parse(readFileSync(filePath, "utf8")) as {
    args: Record<string, unknown>;
    env: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(stored.args), [
    "--alias",
    "--ctx-size",
    "--port",
  ]);
  assert.deepEqual(Object.keys(stored.env), ["ALPHA", "ZED"]);
});

test("updateInstance preserves positionalArgs when the patch omits them", () => {
  const name = uniqueName("pos");
  createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    positionalArgs: ["serve", "model-id"],
    env: {},
    memory: [],
  });

  const updated = updateInstance(name, { args: { "--port": 8080 } });
  assert.deepEqual(updated?.positionalArgs, ["serve", "model-id"]);

  const cleared = updateInstance(name, { positionalArgs: [] });
  assert.deepEqual(cleared?.positionalArgs, []);
});

test("getInstance/listInstances read back from files", () => {
  const name = uniqueName("inst");
  const created = createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });

  resetInstancesCache();
  assert.equal(getInstance(created.name)?.name, name);
  assert.ok(listInstances().some((item) => item.name === created.name));
});

test("createInstance rejects duplicate names", () => {
  const name = uniqueName("dup");
  createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });
  assert.throws(
    () =>
      createInstance({
        name,
        kind: "llama-server",
        rpcWorkers: [],
        binaryPathRefId: binaryRefId,
        args: {},
        env: {},
        memory: [],
      }),
    InstanceNameConflictError,
  );
});

test("updateInstance renaming moves the file", () => {
  const name = uniqueName("old");
  const created = createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });

  const newName = uniqueName("new");
  const updated = updateInstance(created.name, { name: newName });

  assert.equal(updated?.name, newName);
  assert.equal(existsSync(resolve(config.instancesDir, `${name}.json`)), false);
  assert.ok(existsSync(resolve(config.instancesDir, `${newName}.json`)));
  assert.equal(getInstance(name), null);
  assert.equal(getInstance(newName)?.name, newName);
});

test("updateInstance rejects renaming onto an existing name", () => {
  const a = createInstance({
    name: uniqueName("a"),
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });
  const b = createInstance({
    name: uniqueName("b"),
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });

  assert.throws(
    () => updateInstance(b.name, { name: a.name }),
    InstanceNameConflictError,
  );
});

test("deleteInstance removes the file and prunes process_runs", () => {
  const name = uniqueName("del");
  const created = createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });
  createProcessRun({
    instanceId: created.name,
    pid: 1234,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: "/tmp/x.log",
    rawLogPath: null,
  });
  assert.ok(latestProcessRun(created.name));

  assert.equal(deleteInstance(created.name), true);
  assert.equal(existsSync(resolve(config.instancesDir, `${name}.json`)), false);
  assert.equal(latestProcessRun(created.name), null);
  assert.equal(getInstance(created.name), null);
});

test("createInstance defaults kind to llama-server and persists it", () => {
  const name = uniqueName("kind");
  const created = createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });
  assert.equal(created.kind, "llama-server");

  const stored = JSON.parse(
    readFileSync(resolve(config.instancesDir, `${name}.json`), "utf8"),
  ) as { kind?: unknown };
  assert.equal(stored.kind, "llama-server");
});

test("a legacy instance file without kind reads back as llama-server", () => {
  const name = uniqueName("legacy");
  writeFileSync(
    resolve(config.instancesDir, `${name}.json`),
    JSON.stringify({
      name,
      binaryPath: "/opt/llama/llama-server",
      args: {},
      env: {},
      memory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  resetInstancesCache();
  assert.equal(getInstance(name)?.kind, "llama-server");
});

test("a malformed instance file is quarantined while others keep serving", () => {
  const name = uniqueName("bad");
  const path = resolve(config.instancesDir, `${name}.json`);
  writeFileSync(path, "{ not json", "utf8");
  resetInstancesCache();
  assert.equal(
    listInstances().some((instance) => instance.name === name),
    false,
  );
  assert.deepEqual(listQuarantinedInstanceNames(), [name]);
  unlinkSync(path);
  resetInstancesCache();
  assert.deepEqual(listQuarantinedInstanceNames(), []);
});

test("createInstance persists the descriptor scheduling default", () => {
  const name = uniqueName("schedule");
  const created = createInstance({
    name,
    kind: "ktransformers",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
    engineConfig: {
      type: "ktransformers",
      model: "deepseek-ai/DeepSeek-V3",
      cpuWeights: "/models/deepseek-v3-kt",
      method: "AMXINT4",
    },
  });

  assert.deepEqual(created.scheduling, { evictionPolicy: "idle-only" });
  const stored = JSON.parse(
    readFileSync(resolve(config.instancesDir, `${name}.json`), "utf8"),
  ) as { scheduling?: unknown };
  assert.deepEqual(stored.scheduling, { evictionPolicy: "idle-only" });
});

test("updateInstance rejects reserved KTransformers raw arguments", () => {
  const name = uniqueName("kt-args");
  createInstance({
    name,
    kind: "ktransformers",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
    engineConfig: {
      type: "ktransformers",
      model: "deepseek-ai/DeepSeek-V3",
      cpuWeights: "/models/deepseek-v3-kt",
      method: "AMXINT4",
    },
  });

  assert.throws(
    () => updateInstance(name, { args: { "--model": "duplicate" } }),
    InstanceConfigValidationError,
  );
});
