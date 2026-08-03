import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { createLlamaOriginRepository } from "../test/llama-origin.js";
import { resetSourceRepositoryOperationJobsForTests } from "../sources/jobs.js";
import { registerLlamaSourceRoutes } from "./llama-source.routes.js";
import { registerSourceRepositoryRoutes } from "./source-repositories.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerSourceRepositoryRoutes(app);
  registerLlamaSourceRoutes(app);
  return app;
}

beforeEach(() => {
  resetSourceRepositoryOperationJobsForTests();
  rmSync(config.sourcesDir, { recursive: true, force: true });
  mkdirSync(config.sourcesDir, { recursive: true });
  writeFileSync(
    config.settingsFile,
    `${JSON.stringify(
      {
        sourceRepositories: [
          {
            id: "llama-cpp",
            adapter: "llama-cpp",
            originUrl: "https://github.com/ggml-org/llama.cpp.git",
            location: { type: "managed" },
            updatedAt: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});

function createLlamaOrigin() {
  return pathToFileURL(createLlamaOriginRepository("route-llama-origin")).href;
}

async function waitForOperation(app: Hono) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await app.request(
      "/api/source-repositories/llama-cpp/operation",
    );
    const payload = (await response.json()) as {
      data: { status: string; progress: number } | null;
    };
    if (payload.data?.status !== "running") return payload.data;
    await new Promise((resolveDone) => setTimeout(resolveDone, 20));
  }
  throw new Error("source route job did not finish in time");
}

test("source repository routes expose a missing managed llama.cpp checkout", async () => {
  const app = appWithRoutes();
  const listResponse = await app.request("/api/source-repositories");
  assert.equal(listResponse.status, 200);
  const listPayload = (await listResponse.json()) as {
    data: Array<{
      spec: { id: string; location: { type: string } };
      state: string;
    }>;
  };
  assert.equal(listPayload.data[0]?.spec.id, "llama-cpp");
  assert.deepEqual(listPayload.data[0]?.spec.location, { type: "managed" });
  assert.equal(listPayload.data[0]?.state, "missing");

  const driftResponse = await app.request(
    "/api/source-repositories/llama-cpp/drift",
  );
  assert.equal(driftResponse.status, 200);
  const driftPayload = (await driftResponse.json()) as {
    data: { status: string; commit: string | null; sections: unknown[] };
  };
  assert.equal(driftPayload.data.status, "unavailable");
  assert.equal(driftPayload.data.commit, null);
  assert.deepEqual(driftPayload.data.sections, []);
});

test("origin can be changed before the managed checkout is cloned", async () => {
  const app = appWithRoutes();
  const originUrl = "ssh://git@example.com/team/llama.cpp.git";
  const response = await app.request(
    "/api/source-repositories/llama-cpp/settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originUrl }),
    },
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data: { status: { spec: { originUrl: string }; state: string } };
  };
  assert.equal(payload.data.status.spec.originUrl, originUrl);
  assert.equal(payload.data.status.state, "missing");
});

test("clone route starts a pollable background source operation", async () => {
  const app = appWithRoutes();
  const response = await app.request(
    "/api/source-repositories/llama-cpp/clone",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        originUrl: createLlamaOrigin(),
        branch: null,
      }),
    },
  );

  assert.equal(response.status, 202);
  const started = (await response.json()) as {
    data: { operation: string; status: string; startedAt: string };
  };
  assert.equal(started.data.operation, "clone");
  assert.equal(started.data.status, "running");
  assert.ok(started.data.startedAt);

  const finished = await waitForOperation(app);
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.progress, 100);
});

test("mutating source routes stay reachable on a non-loopback listener without auth", async () => {
  const app = appWithRoutes();
  const originalHost = config.host;
  config.host = "0.0.0.0";
  try {
    for (const request of [
      { path: "/api/source-repositories/llama-cpp/pull", method: "POST" },
      { path: "/api/llama-source/pull", method: "POST" },
      { path: "/api/llama-source/checkout", method: "POST" },
      { path: "/api/llama-source/settings", method: "PUT" },
    ]) {
      const response = await app.request(request.path, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.notEqual(response.status, 403, request.path);
    }

    const readResponse = await app.request("/api/llama-source/status");
    assert.equal(readResponse.status, 200);
  } finally {
    config.host = originalHost;
  }
});

test("unknown source repository ids are rejected", async () => {
  const response = await appWithRoutes().request(
    "/api/source-repositories/unknown/status",
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /unknown source repository/);
});
