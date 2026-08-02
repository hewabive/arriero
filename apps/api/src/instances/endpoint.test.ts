import assert from "node:assert/strict";
import test from "node:test";

import type { Instance } from "@arriero/core";

import { instanceBaseUrl, rpcWorkerEndpoint } from "./endpoint.js";

function worker(args: Instance["args"]): Instance {
  return {
    name: "rpc-A",
    kind: "rpc-worker",
    binaryPath: "/tmp/rpc-server",
    binaryPathRefId: "bin",
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "running",
    pid: 1,
  };
}

test("rpcWorkerEndpoint reads --host and --port", () => {
  assert.deepEqual(
    rpcWorkerEndpoint(worker({ "--host": "10.0.0.2", "--port": 50100 })),
    {
      host: "10.0.0.2",
      port: 50100,
    },
  );
});

test("rpcWorkerEndpoint defaults the port to 50052 and normalizes wildcard host", () => {
  assert.deepEqual(rpcWorkerEndpoint(worker({ "--host": "0.0.0.0" })), {
    host: "127.0.0.1",
    port: 50052,
  });
});

test("rpcWorkerEndpoint accepts the short -p port flag", () => {
  assert.deepEqual(rpcWorkerEndpoint(worker({ "-p": 50200 })), {
    host: "127.0.0.1",
    port: 50200,
  });
});

test("rpcWorkerEndpoint returns null for a unix-socket host", () => {
  assert.equal(rpcWorkerEndpoint(worker({ "--host": "/tmp/x.sock" })), null);
});

test("instanceBaseUrl uses the vllm descriptor defaults", () => {
  assert.equal(
    instanceBaseUrl({ ...worker({}), kind: "vllm" }),
    "http://127.0.0.1:8000",
  );
  assert.equal(
    instanceBaseUrl({
      ...worker({ "--host": "0.0.0.0", "--port": 9000 }),
      kind: "vllm",
    }),
    "http://127.0.0.1:9000",
  );
});
