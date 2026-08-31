import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  proxyEngineGates,
  requestLeasePreemptible,
  schedulerTargetPreemptible,
} from "./engine-capabilities.js";

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
  assert.equal(gates.requestLease, true);
  assert.equal(gates.modelLoadUnload, true);
  assert.equal(gates.slotSave, true);
  assert.equal(gates.streamResume, true);
  assert.equal(gates.sseTimings, true);
  assert.equal(gates.reasoningControl, true);
});

test("rpc-worker instance disables every proxy engine gate", () => {
  const gates = proxyEngineGates(instance("rpc-worker"));
  assert.equal(gates.requestLease, false);
  assert.equal(gates.modelLoadUnload, false);
  assert.equal(gates.slotSave, false);
  assert.equal(gates.streamResume, false);
  assert.equal(gates.sseTimings, false);
  assert.equal(gates.reasoningControl, false);
});

test("no instance (external endpoint) disables every proxy engine gate", () => {
  assert.deepEqual(proxyEngineGates(null), {
    requestLease: false,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
  });
});

test("vllm requests leases but opts out of llama lifecycle verbs", () => {
  assert.deepEqual(proxyEngineGates(instance("vllm")), {
    requestLease: true,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
  });
});

test("KTransformers requests leases without llama lifecycle or stream extensions", () => {
  assert.deepEqual(proxyEngineGates(instance("ktransformers")), {
    requestLease: true,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
  });
});

test("idle-only instances can be displaced only after requests drain", () => {
  const kt = {
    ...instance("ktransformers"),
    scheduling: { evictionPolicy: "idle-only" as const },
  };
  assert.equal(schedulerTargetPreemptible(kt, true, 0), true);
  assert.equal(schedulerTargetPreemptible(kt, true, 1), false);
  assert.equal(requestLeasePreemptible(kt, true), false);
});

test("never and preemptible scheduling policies gate both scheduler and lease", () => {
  const base = instance("ktransformers");
  const never = {
    ...base,
    scheduling: { evictionPolicy: "never" as const },
  };
  const preemptible = {
    ...base,
    scheduling: { evictionPolicy: "preemptible" as const },
  };
  assert.equal(schedulerTargetPreemptible(never, true, 0), false);
  assert.equal(requestLeasePreemptible(never, true), false);
  assert.equal(schedulerTargetPreemptible(preemptible, true, 1), true);
  assert.equal(requestLeasePreemptible(preemptible, true), true);
});
