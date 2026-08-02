import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Instance } from "@arriero/core";

import {
  listInstanceRecords,
  removeInstanceRecord,
  resetInstancesCache,
  writeInstanceRecord,
} from "../instances/config-files.js";
import { listRpcWorkerCandidates } from "./rpc-worker-catalog.js";

function writeRecord(
  name: string,
  kind: Instance["kind"],
  args: Instance["args"],
) {
  writeInstanceRecord({
    name,
    kind,
    binaryPath: "/tmp/bin",
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
  });
}

beforeEach(() => {
  resetInstancesCache();
  for (const record of listInstanceRecords()) {
    removeInstanceRecord(record.name);
  }
});

test("lists local rpc-worker instances with host:port endpoints", async () => {
  writeRecord("w1", "rpc-worker", { "--host": "0.0.0.0", "--port": 50100 });
  writeRecord("server", "llama-server", { "--port": 8080 });

  const candidates = await listRpcWorkerCandidates();

  assert.equal(candidates.length, 1);
  const worker = candidates[0]!;
  assert.equal(worker.nodeId, null);
  assert.equal(worker.instanceName, "w1");
  assert.equal(worker.endpoint, "127.0.0.1:50100");
  assert.equal(worker.status, "stopped");
});

test("defaults the rpc-server port when absent", async () => {
  writeRecord("w-default", "rpc-worker", {});

  const candidates = await listRpcWorkerCandidates();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.endpoint, "127.0.0.1:50052");
});

test("excludes llama-server instances", async () => {
  writeRecord("only-server", "llama-server", { "--port": 8080 });

  assert.deepEqual(await listRpcWorkerCandidates(), []);
});
