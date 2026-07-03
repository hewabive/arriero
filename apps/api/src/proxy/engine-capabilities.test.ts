import type { Instance } from "@llama-manager/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { proxyEngineGates } from "./engine-capabilities.js";

function instance(kind: Instance["kind"]): Instance {
  return {
    name: "gates-test",
    kind,
    binaryPath: "/bin/true",
    binaryPathRefId: "ref",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "running",
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Instance;
}

test("llama-server instance enables every proxy engine gate", () => {
  const gates = proxyEngineGates(instance("llama-server"));
  assert.equal(gates.modelLoadUnload, true);
  assert.equal(gates.slotSave, true);
  assert.equal(gates.streamResume, true);
  assert.equal(gates.sseTimings, true);
});

test("rpc-worker instance disables every proxy engine gate", () => {
  const gates = proxyEngineGates(instance("rpc-worker"));
  assert.equal(gates.modelLoadUnload, false);
  assert.equal(gates.slotSave, false);
  assert.equal(gates.streamResume, false);
  assert.equal(gates.sseTimings, false);
});

test("no instance (external endpoint) disables every proxy engine gate", () => {
  assert.deepEqual(proxyEngineGates(null), {
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
  });
});
