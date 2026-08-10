import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import { createPathCatalogEntry } from "../path-catalog/repository.js";
import { registerInstanceRoutes } from "./instances.routes.js";

function appWithBinary(kind: "vllm" | "rpc-worker") {
  const app = new Hono();
  registerInstanceRoutes(app);
  const binary = createPathCatalogEntry({
    kind: "binary",
    name: `${kind}-${Date.now()}-${Math.random()}`,
    path: process.execPath,
    engineKind: kind,
  });
  return { app, binaryPathRefId: binary.id };
}

test("vLLM preview forwards the positional model to preflight", async () => {
  const { app, binaryPathRefId } = appWithBinary("vllm");
  const response = await app.request("/api/instances/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "vllm",
      binaryPathRefId,
      positionalArgs: ["Qwen/Qwen3-0.6B"],
      args: { "--port": 65431 },
    }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data: { issues: Array<{ field: string }> };
  };
  assert.equal(
    payload.data.issues.some((issue) => issue.field === "positionalArgs"),
    false,
  );
});

test("preview rejects an unknown memory pool like create", async () => {
  const { app, binaryPathRefId } = appWithBinary("vllm");
  const response = await app.request("/api/instances/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "vllm",
      binaryPathRefId,
      positionalArgs: ["Qwen/Qwen3-0.6B"],
      memory: [{ poolId: "missing-pool", bytes: 1 }],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "memory pool not found: missing-pool",
  });
});

test("preview rejects RPC worker references on an RPC worker", async () => {
  const { app, binaryPathRefId } = appWithBinary("rpc-worker");
  const response = await app.request("/api/instances/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "rpc-worker",
      binaryPathRefId,
      rpcWorkers: [{ nodeId: null, instanceName: "nested-worker" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "rpc-worker instances cannot reference other rpc workers",
  });
});
