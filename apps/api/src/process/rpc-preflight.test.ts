import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fabricIssue,
  referencingOrchestrators,
  RPC_SLOW_FABRIC_RTT_MS,
  validateRpcWorkerReadiness,
} from "./rpc-preflight.js";

function instance(overrides: Partial<Instance>): Instance {
  return {
    name: "x",
    kind: "llama-server",
    binaryPath: "/bin/llama-server",
    binaryPathRefId: "",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "running",
    pid: 1,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides,
  } as Instance;
}

function orchestrator(
  rpcWorkers: Instance["rpcWorkers"],
  extra: Partial<Instance> = {},
) {
  return instance({
    name: "orch",
    kind: "llama-server",
    status: "stopped",
    rpcWorkers,
    ...extra,
  });
}

test("no issues when there are no rpc workers", async () => {
  assert.deepEqual(await validateRpcWorkerReadiness(orchestrator([]), []), []);
});

test("errors when a referenced local worker is missing", async () => {
  const issues = await validateRpcWorkerReadiness(
    orchestrator([{ nodeId: null, instanceName: "w1" }]),
    [],
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /was not found on this node/);
});

test("errors when the referenced instance is not an rpc-worker", async () => {
  const peers = [
    instance({ name: "w1", kind: "llama-server", status: "running" }),
  ];
  const issues = await validateRpcWorkerReadiness(
    orchestrator([{ nodeId: null, instanceName: "w1" }]),
    peers,
  );
  assert.match(issues[0]!.message, /is not an rpc-worker/);
});

test("errors when a referenced worker is not running", async () => {
  const peers = [
    instance({ name: "w1", kind: "rpc-worker", status: "stopped" }),
  ];
  const issues = await validateRpcWorkerReadiness(
    orchestrator([{ nodeId: null, instanceName: "w1" }]),
    peers,
  );
  assert.match(issues[0]!.message, /is not running \(stopped\)/);
});

test("passes when the referenced worker is running and free", async () => {
  const peers = [
    instance({ name: "w1", kind: "rpc-worker", status: "running" }),
  ];
  assert.deepEqual(
    await validateRpcWorkerReadiness(
      orchestrator([{ nodeId: null, instanceName: "w1" }]),
      peers,
    ),
    [],
  );
});

test("fabricIssue is silent when the probe could not be measured", () => {
  assert.equal(fabricIssue("w1", null), null);
});

test("fabricIssue warns about a slow fabric above the threshold", () => {
  const issue = fabricIssue("w1", RPC_SLOW_FABRIC_RTT_MS + 75);
  assert.equal(issue?.level, "warning");
  assert.match(issue!.message, /80 ms away/);
  assert.match(issue!.message, /fast LAN/);
});

test("fabricIssue is silent for a fast fabric", () => {
  assert.equal(fabricIssue("w1", 1), null);
});

test("referencingOrchestrators lists running and starting local holders of a worker", () => {
  const peers = [
    instance({ name: "w1", kind: "rpc-worker", status: "running" }),
    instance({
      name: "orchA",
      kind: "llama-server",
      status: "running",
      rpcWorkers: [{ nodeId: null, instanceName: "w1" }],
    }),
    instance({
      name: "orchB",
      kind: "llama-server",
      status: "starting",
      rpcWorkers: [{ nodeId: null, instanceName: "w1" }],
    }),
  ];
  assert.deepEqual(referencingOrchestrators("w1", peers), ["orchA", "orchB"]);
});

test("referencingOrchestrators ignores stopped holders and remote-node refs", () => {
  const peers = [
    instance({
      name: "stopped",
      kind: "llama-server",
      status: "stopped",
      rpcWorkers: [{ nodeId: null, instanceName: "w1" }],
    }),
    instance({
      name: "remote",
      kind: "llama-server",
      status: "running",
      rpcWorkers: [{ nodeId: "node-2", instanceName: "w1" }],
    }),
  ];
  assert.deepEqual(referencingOrchestrators("w1", peers), []);
});

test("errors when the worker is already held by another running orchestrator", async () => {
  const peers = [
    instance({ name: "w1", kind: "rpc-worker", status: "running" }),
    instance({
      name: "other",
      kind: "llama-server",
      status: "running",
      rpcWorkers: [{ nodeId: null, instanceName: "w1" }],
    }),
  ];
  const issues = await validateRpcWorkerReadiness(
    orchestrator([{ nodeId: null, instanceName: "w1" }]),
    peers,
  );
  assert.match(
    issues[0]!.message,
    /already in use by running instance "other"/,
  );
});
