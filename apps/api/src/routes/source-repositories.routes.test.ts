import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { registerSourceRepositoryRoutes } from "./source-repositories.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerSourceRepositoryRoutes(app);
  return app;
}

beforeEach(() => {
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

test("unknown source repository ids are rejected", async () => {
  const response = await appWithRoutes().request(
    "/api/source-repositories/unknown/status",
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /unknown source repository/);
});
