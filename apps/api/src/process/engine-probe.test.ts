import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { engineProbe } from "./engine-probe.js";

test("KTransformers readiness follows HTTP health 503 to 200", async () => {
  let ready = false;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.statusCode = ready ? 200 : 503;
      response.end(JSON.stringify({ status: ready ? "ok" : "loading" }));
      return;
    }
    if (request.url === "/v1/models") {
      response.statusCode = 200;
      response.end(JSON.stringify({ data: ready ? [{ id: "kt-model" }] : [] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const instance: Instance = {
    name: "kt-probe",
    kind: "ktransformers",
    binaryPath: "/opt/kt/bin/sglang",
    binaryPathRefId: "kt-bin",
    args: { "--host": "127.0.0.1", "--port": address.port },
    env: {},
    memory: [],
    rpcWorkers: [],
    engineConfig: {
      type: "ktransformers",
      model: "owner/model",
      cpuWeights: "/models/weights",
      method: "FP8",
    },
    scheduling: { evictionPolicy: "idle-only" },
    status: "running",
    pid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    const loading = await engineProbe("ktransformers").probe(instance);
    assert.equal(loading.health.ok, false);
    assert.equal(loading.health.status, 503);

    ready = true;
    const healthy = await engineProbe("ktransformers").probe(instance);
    assert.equal(healthy.health.ok, true);
    assert.equal(healthy.health.status, 200);
    assert.deepEqual(healthy.models.body, { data: [{ id: "kt-model" }] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("KTransformers readiness tolerates a slow SGLang health response", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      setTimeout(() => response.end(JSON.stringify({ status: "ok" })), 1_600);
      return;
    }
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "kt-model" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const instance: Instance = {
    name: "slow-kt-probe",
    kind: "ktransformers",
    binaryPath: "/opt/kt/bin/sglang",
    binaryPathRefId: "kt-bin",
    args: { "--host": "127.0.0.1", "--port": address.port },
    env: {},
    memory: [],
    rpcWorkers: [],
    engineConfig: {
      type: "ktransformers",
      model: "owner/model",
      cpuWeights: "/models/weights",
      method: "FP8",
    },
    scheduling: { evictionPolicy: "idle-only" },
    status: "running",
    pid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    const healthy = await engineProbe("ktransformers").probe(instance);
    assert.equal(healthy.health.ok, true);
    assert.ok(healthy.health.latencyMs >= 1_500);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
