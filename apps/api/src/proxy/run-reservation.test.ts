import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { createInstance, deleteInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { ensureResourcePoolsScaffold } from "../resources/repository.js";
import { resetConfigFilesCache } from "./config-files.js";
import { computeDomainCoordinator } from "./domain-coordinator.js";
import { instanceEndpointId } from "./endpoints.js";
import { apiProxyInflight } from "./inflight.js";
import { createApiProxyTarget } from "./repository.js";
import {
  ApiProxyReservationError,
  apiProxyInstanceReservation,
  apiProxyReservationDiagnostic,
  apiProxyReservationScope,
  apiProxyTargetInstanceName,
  reserveApiProxyInstances,
} from "./run-reservation.js";

const fixture = instanceTestFixture("run-reservation");
const created: string[] = [];

function instance(draws: Array<{ poolId: string; bytes: number }>): string {
  if (!fixture.binaryRefId()) fixture.seedBinaryRef();
  const name = fixture.uniqueName("engine");
  createInstance({
    name,
    kind: "llama-server",
    binaryPathRefId: fixture.binaryRefId(),
    rpcWorkers: [],
    args: {},
    env: {},
    memory: draws,
  });
  created.push(name);
  return name;
}

function target(instanceName: string) {
  return createApiProxyTarget({
    name: `target-${instanceName}`,
    endpointId: instanceEndpointId(instanceName),
    model: null,
    role: "interactive",
    priority: 100,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  });
}

beforeEach(() => {
  for (const name of created.splice(0)) {
    deleteInstance(name);
  }
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  ensureResourcePoolsScaffold();
  apiProxyInflight.reset();
});

test("target ids of every form resolve to their instance", () => {
  assert.equal(
    apiProxyTargetInstanceName("t1", { endpointId: "instance:qwen" }),
    "qwen",
  );
  assert.equal(apiProxyTargetInstanceName("serve:qwen", null), "qwen");
  assert.equal(
    apiProxyTargetInstanceName("endpoint:instance:qwen#qwen-model", null),
    "qwen",
  );
  assert.equal(apiProxyTargetInstanceName("endpoint:cloud#gpt", null), null);
  assert.equal(
    apiProxyTargetInstanceName("t2", { endpointId: "remote:node:qwen" }),
    null,
  );
});

test("the scope covers instances drawing from the same pools", () => {
  const benchmarked = instance([{ poolId: "host", bytes: 1 }]);
  const neighbor = instance([{ poolId: "host", bytes: 1 }]);
  const unrelated = instance([]);
  target(neighbor);
  const scope = apiProxyReservationScope(benchmarked);
  assert.deepEqual(scope.instanceNames, [benchmarked, neighbor].sort());
  assert.deepEqual(scope.targetNames, [`target-${neighbor}`]);
  assert.equal(scope.drawsDeclared, true);
  const alone = apiProxyReservationScope(unrelated);
  assert.deepEqual(alone.instanceNames, [unrelated]);
  assert.equal(alone.drawsDeclared, false);
});

test("a reservation refuses a second run and tells clients when to retry", async () => {
  const name = instance([]);
  const handle = await reserveApiProxyInstances({
    runId: "run-1",
    label: "replay",
    instanceName: name,
    expectedEndAt: new Date(Date.now() + 90_000).toISOString(),
    drainTimeoutMs: 1000,
  });
  assert.equal(apiProxyInstanceReservation(name)?.runId, "run-1");
  await assert.rejects(
    reserveApiProxyInstances({
      runId: "run-2",
      label: "other",
      instanceName: name,
      expectedEndAt: null,
      drainTimeoutMs: 1000,
    }),
    ApiProxyReservationError,
  );
  const diagnostic = apiProxyReservationDiagnostic(handle.reservation);
  assert.equal(diagnostic.status, 503);
  assert.equal(diagnostic.code, "arriero_proxy_instance_reserved");
  assert.ok((diagnostic.retryAfterSeconds ?? 0) > 80);
  handle.release();
  assert.equal(apiProxyInstanceReservation(name), null);
});

test("reserving waits for proxy requests already running on the instance", async () => {
  const name = instance([]);
  const running = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: target(name).id,
  });
  await assert.rejects(
    reserveApiProxyInstances({
      runId: "run-busy",
      label: "replay",
      instanceName: name,
      expectedEndAt: null,
      drainTimeoutMs: 300,
    }),
    /still running/,
  );
  assert.equal(apiProxyInstanceReservation(name), null);
  setTimeout(() => running.end(true), 100);
  const handle = await reserveApiProxyInstances({
    runId: "run-drained",
    label: "replay",
    instanceName: name,
    expectedEndAt: null,
    drainTimeoutMs: 2000,
  });
  handle.release();
});

test("the maintenance lease holds the instance's pools while reserved", async () => {
  const name = instance([{ poolId: "host", bytes: 1 }]);
  const handle = await reserveApiProxyInstances({
    runId: "run-lease",
    label: "replay",
    instanceName: name,
    expectedEndAt: null,
    drainTimeoutMs: 1000,
  });
  assert.equal(computeDomainCoordinator.tryAcquireMaintenance(["host"]), null);
  handle.release();
  const lease = computeDomainCoordinator.tryAcquireMaintenance(["host"]);
  assert.ok(lease);
  lease.release();
});
