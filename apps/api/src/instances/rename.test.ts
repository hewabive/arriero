import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  createProcessRun,
  latestProcessRun,
  updateProcessRun,
} from "../process/runs-repository.js";
import { resetConfigFilesCache } from "../proxy/config-files.js";
import {
  createApiProxyModel,
  createApiProxyTarget,
  getApiProxyModel,
  getApiProxyTarget,
} from "../proxy/repository.js";
import { resetInstancesCache } from "./config-files.js";
import { InstanceRenameBlockedError } from "./rename.js";
import { createInstance, getInstance, updateInstance } from "./repository.js";
import { instanceTestFixture } from "./test-fixtures.js";

const { uniqueName, seedBinaryRef, seedInstance, binaryRefId } =
  instanceTestFixture("rename");

beforeEach(() => {
  resetInstancesCache();
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  seedBinaryRef();
});

test("rename rewrites proxy target endpointId and model endpoint routes", () => {
  const name = uniqueName("inst");
  seedInstance(name);
  const target = createApiProxyTarget({
    name: "kept-target-name",
    endpointId: `instance:${name}`,
    model: null,
    role: "background",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: true,
    slotIds: [0],
    idleUnloadMs: null,
  });
  const routedModel = createApiProxyModel({
    modelId: "routed-model",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: {
      type: "endpoint",
      endpointId: `instance:${name}`,
      upstreamModel: null,
    },
    description: null,
    blockedMessage: "",
    reasoning: null,
  });
  const unrelatedTarget = createApiProxyTarget({
    name: "unrelated",
    endpointId: "instance:other-instance",
    model: null,
    role: "background",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: true,
    slotIds: [0],
    idleUnloadMs: null,
  });

  const newName = uniqueName("renamed");
  updateInstance(name, { name: newName });

  assert.equal(getApiProxyTarget(target.id)?.endpointId, `instance:${newName}`);
  assert.equal(getApiProxyTarget(target.id)?.name, "kept-target-name");
  const routeTo = getApiProxyModel(routedModel.id)?.routeTo;
  assert.equal(routeTo?.type, "endpoint");
  assert.equal(
    routeTo?.type === "endpoint" ? routeTo.endpointId : null,
    `instance:${newName}`,
  );
  assert.equal(
    getApiProxyTarget(unrelatedTarget.id)?.endpointId,
    "instance:other-instance",
  );
});

test("rename rewrites local rpc worker references but not remote ones", () => {
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
    binaryPathRefId: binaryRefId(),
    args: {},
    env: {},
    memory: [],
  });

  const newName = uniqueName("worker-renamed");
  updateInstance(workerName, { name: newName });

  const orchestrator = getInstance(orchestratorName);
  assert.deepEqual(orchestrator?.rpcWorkers, [
    { nodeId: null, instanceName: newName },
    { nodeId: "node-1", instanceName: workerName },
  ]);
});

test("rename moves closed process run history to the new name", () => {
  const name = uniqueName("history");
  seedInstance(name);
  const runId = createProcessRun({
    instanceId: name,
    pid: 4321,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: "/tmp/history.log",
    rawLogPath: null,
  });
  updateProcessRun(runId, {
    status: "exited",
    stoppedAt: "2026-01-01T01:00:00.000Z",
    exitCode: 0,
  });

  const newName = uniqueName("history-renamed");
  updateInstance(name, { name: newName });

  assert.equal(latestProcessRun(name), null);
  assert.equal(latestProcessRun(newName)?.id, runId);
});

test("rename is refused while the instance has an open process run", () => {
  const name = uniqueName("live");
  seedInstance(name);
  const runId = createProcessRun({
    instanceId: name,
    pid: 9876,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: "/tmp/live.log",
    rawLogPath: null,
  });

  const newName = uniqueName("live-renamed");
  assert.throws(
    () => updateInstance(name, { name: newName }),
    InstanceRenameBlockedError,
  );
  assert.equal(getInstance(name)?.name, name);

  updateProcessRun(runId, {
    status: "exited",
    stoppedAt: "2026-01-01T01:00:00.000Z",
    exitCode: 0,
  });
  assert.equal(updateInstance(name, { name: newName })?.name, newName);
});

test("a non-rename update leaves an open process run untouched", () => {
  const name = uniqueName("hot-edit");
  seedInstance(name);
  createProcessRun({
    instanceId: name,
    pid: 1111,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: "/tmp/hot-edit.log",
    rawLogPath: null,
  });

  const updated = updateInstance(name, { args: { "--port": 8123 } });
  assert.equal(updated?.name, name);
  assert.equal(latestProcessRun(name)?.status, "running");
});

test("rename moves the saved slots directory", () => {
  const name = uniqueName("slots");
  seedInstance(name);
  const fromDir = resolve(config.slotsDir, name);
  mkdirSync(fromDir, { recursive: true });
  writeFileSync(resolve(fromDir, "slot-0.bin"), "kv", "utf8");

  const newName = uniqueName("slots-renamed");
  updateInstance(name, { name: newName });

  assert.equal(existsSync(fromDir), false);
  assert.ok(existsSync(resolve(config.slotsDir, newName, "slot-0.bin")));
});
