import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import {
  createProcessRun,
  updateProcessRun,
} from "../process/runs-repository.js";
import { resetInstancesCache } from "./config-files.js";
import { createInstance, deleteInstance, getInstance } from "./repository.js";

let binaryRefId: string;
let counter = 0;

function uniqueName(prefix: string) {
  counter += 1;
  return `${prefix}-delete-${counter}`;
}

function seedInstance(
  name: string,
  kind: "llama-server" | "rpc-worker" = "llama-server",
) {
  return createInstance({
    name,
    kind,
    rpcWorkers: [],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });
}

beforeEach(() => {
  resetInstancesCache();
  binaryRefId = createPathCatalogEntry({
    kind: "binary",
    name: uniqueName("bin"),
    path: `/opt/llama/llama-server-delete-${counter}`,
  }).id;
});

test("delete removes local rpc worker references but keeps remote ones", () => {
  const workerName = uniqueName("worker");
  seedInstance(workerName, "rpc-worker");
  const orchestratorName = uniqueName("orchestrator");
  createInstance({
    name: orchestratorName,
    kind: "llama-server",
    rpcWorkers: [
      { nodeId: null, instanceName: workerName },
      { nodeId: "node-1", instanceName: workerName },
    ],
    binaryPathRefId: binaryRefId,
    args: {},
    env: {},
    memory: [],
  });

  assert.equal(deleteInstance(workerName), true);
  assert.deepEqual(getInstance(orchestratorName)?.rpcWorkers, [
    { nodeId: "node-1", instanceName: workerName },
  ]);
});

test("delete removes the slots directory", () => {
  const name = uniqueName("slots");
  seedInstance(name);
  const dir = resolve(config.slotsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "slot-0.bin"), "kv", "utf8");

  assert.equal(deleteInstance(name), true);
  assert.equal(existsSync(dir), false);
});

test("delete removes recorded and orphaned log files but not a sibling's", () => {
  const name = uniqueName("logs");
  const sibling = `${name}-2`;
  seedInstance(name);
  seedInstance(sibling);
  mkdirSync(config.logsDir, { recursive: true });

  const recordedLog = resolve(config.logsDir, `${name}-custom-path.log`);
  writeFileSync(recordedLog, "log", "utf8");
  const runId = createProcessRun({
    instanceId: name,
    pid: 4321,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: recordedLog,
    rawLogPath: null,
  });
  updateProcessRun(runId, {
    status: "exited",
    stoppedAt: "2026-01-01T01:00:00.000Z",
    exitCode: 0,
  });

  const orphanedLog = resolve(config.logsDir, `${name}-1712345.log`);
  const orphanedRawLog = resolve(config.logsDir, `${name}-1712345.raw.log`);
  const siblingLog = resolve(config.logsDir, `${sibling}-1712345.log`);
  writeFileSync(orphanedLog, "log", "utf8");
  writeFileSync(orphanedRawLog, "raw", "utf8");
  writeFileSync(siblingLog, "log", "utf8");

  assert.equal(deleteInstance(name), true);
  assert.equal(existsSync(recordedLog), false);
  assert.equal(existsSync(orphanedLog), false);
  assert.equal(existsSync(orphanedRawLog), false);
  assert.equal(existsSync(siblingLog), true);
});
