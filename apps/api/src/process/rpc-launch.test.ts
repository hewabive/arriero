import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Instance } from "@arriero/core";

import {
  resetInstancesCache,
  writeInstanceRecord,
} from "../instances/config-files.js";
import { resolveRpcArgs } from "./rpc-launch.js";

function writeWorker(name: string, args: Instance["args"]) {
  writeInstanceRecord({
    name,
    kind: "rpc-worker",
    binaryPath: "/tmp/rpc-server",
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  });
}

beforeEach(() => {
  resetInstancesCache();
});

test("resolveRpcArgs builds --rpc from a local worker endpoint", async () => {
  writeWorker("w1", { "--host": "0.0.0.0", "--port": 50100 });
  assert.deepEqual(
    await resolveRpcArgs({
      kind: "llama-server",
      rpcWorkers: [{ nodeId: null, instanceName: "w1" }],
    }),
    ["--rpc", "127.0.0.1:50100"],
  );
});

test("resolveRpcArgs joins multiple local workers comma-separated", async () => {
  writeWorker("w1", { "--port": 50100 });
  writeWorker("w2", { "--port": 50101 });
  assert.deepEqual(
    await resolveRpcArgs({
      kind: "llama-server",
      rpcWorkers: [
        { nodeId: null, instanceName: "w1" },
        { nodeId: null, instanceName: "w2" },
      ],
    }),
    ["--rpc", "127.0.0.1:50100,127.0.0.1:50101"],
  );
});

test("resolveRpcArgs is empty for an rpc-worker kind", async () => {
  assert.deepEqual(
    await resolveRpcArgs({ kind: "rpc-worker", rpcWorkers: [] }),
    [],
  );
});

test("resolveRpcArgs throws on an absent local worker reference", async () => {
  await assert.rejects(
    resolveRpcArgs({
      kind: "llama-server",
      rpcWorkers: [{ nodeId: null, instanceName: "absent" }],
    }),
    /not found on this node/,
  );
});
