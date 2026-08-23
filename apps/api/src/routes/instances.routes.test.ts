import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import { instanceTestFixture } from "../instances/test-fixtures.js";
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

test("reasoning profile resolves per instance kind and 404s on unknown names", async () => {
  const app = new Hono();
  registerInstanceRoutes(app);
  const fixture = instanceTestFixture("reasoning-route");
  fixture.seedBinaryRef();

  const llamaName = fixture.uniqueName("inst");
  fixture.seedInstance(llamaName);
  const llamaResponse = await app.request(
    `/api/instances/${llamaName}/reasoning-profile`,
  );
  assert.equal(llamaResponse.status, 200);
  const llamaPayload = (await llamaResponse.json()) as {
    data: { profile: { interface: string }; source: string } | null;
  };
  assert.equal(llamaPayload.data?.profile.interface, "budget");
  assert.equal(llamaPayload.data?.source, "engine default");

  const workerName = fixture.uniqueName("inst");
  fixture.seedInstance(workerName, "rpc-worker");
  const workerResponse = await app.request(
    `/api/instances/${workerName}/reasoning-profile`,
  );
  assert.equal(workerResponse.status, 200);
  assert.deepEqual(await workerResponse.json(), { data: null });

  const missing = await app.request(
    "/api/instances/absent-reasoning/reasoning-profile",
  );
  assert.equal(missing.status, 404);
});
