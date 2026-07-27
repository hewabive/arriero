import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { createProcessRun } from "../process/runs-repository.js";
import { probeLlamaCapabilities } from "./probe.js";

let clock = 0;

function seedRun(instanceId: string): string {
  clock += 60_000;
  return createProcessRun({
    instanceId,
    pid: 4321,
    status: "running",
    startedAt: new Date(clock).toISOString(),
    logPath: `/tmp/${instanceId}.log`,
    rawLogPath: `/tmp/${instanceId}.raw.log`,
  });
}

function makeInstance(name: string, port: number): Instance {
  return {
    name,
    binaryPath: "/bin/true",
    status: "running",
    pid: 1234,
    args: { "--host": "127.0.0.1", "--port": String(port) },
    env: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Instance;
}

async function startCountingServer() {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "'messages' is required" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    count: () => requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("capability probe is cached per process run", async () => {
  const server = await startCountingServer();
  try {
    const name = `cap-cache-${server.port}`;
    seedRun(name);
    const instance = makeInstance(name, server.port);

    await probeLlamaCapabilities(instance);
    const afterFirst = server.count();
    assert.ok(afterFirst > 0);

    await probeLlamaCapabilities(instance);
    assert.equal(server.count(), afterFirst, "second call must hit the cache");
  } finally {
    await server.close();
  }
});

test("force bypasses the cache and re-probes", async () => {
  const server = await startCountingServer();
  try {
    const name = `cap-force-${server.port}`;
    seedRun(name);
    const instance = makeInstance(name, server.port);

    await probeLlamaCapabilities(instance);
    const afterFirst = server.count();

    await probeLlamaCapabilities(instance, { force: true });
    assert.ok(server.count() > afterFirst, "force must re-probe");
  } finally {
    await server.close();
  }
});

test("a new process run invalidates the cache", async () => {
  const server = await startCountingServer();
  try {
    const name = `cap-restart-${server.port}`;
    seedRun(name);
    const instance = makeInstance(name, server.port);

    await probeLlamaCapabilities(instance);
    const afterFirst = server.count();

    seedRun(name);
    await probeLlamaCapabilities(instance);
    assert.ok(server.count() > afterFirst, "a new run must re-probe");
  } finally {
    await server.close();
  }
});
