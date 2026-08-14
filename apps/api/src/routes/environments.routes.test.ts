import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { resetSettingsCache } from "../settings/store.js";
import { resetEnvironmentRepository } from "../envs/repository.js";
import { registerEnvironmentRoutes } from "./environments.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerEnvironmentRoutes(app);
  return app;
}

beforeEach(() => {
  resetEnvironmentRepository();
  writeFileSync(
    config.settingsFile,
    `${JSON.stringify(
      {
        modelScan: { directory: "/models", maxDepth: 4 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  resetSettingsCache();
});

test("environment repository settings default to uv sources", async () => {
  const response = await appWithRoutes().request("/api/environments/settings");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      packageIndexUrl: null,
      pythonMirrorUrl: null,
    },
  });
});

test("environment repository settings persist one site profile", async () => {
  const app = appWithRoutes();
  const settings = {
    packageIndexUrl: "https://packages.example/simple",
    pythonMirrorUrl: "https://python.example/python-build-standalone",
  } as const;
  const response = await app.request("/api/environments/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: settings });
  const stored = JSON.parse(readFileSync(config.settingsFile, "utf8")) as {
    environments: unknown;
    modelScan: unknown;
  };
  assert.deepEqual(stored.environments, settings);
  assert.deepEqual(stored.modelScan, { directory: "/models", maxDepth: 4 });
});

test("repository sources are independent and may use any valid host", async () => {
  const app = appWithRoutes();
  const packageOnly = await app.request("/api/environments/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      packageIndexUrl: "https://pypi.org/simple",
      pythonMirrorUrl: null,
    }),
  });
  assert.equal(packageOnly.status, 200);

  const mirrorOnly = await app.request("/api/environments/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      packageIndexUrl: null,
      pythonMirrorUrl:
        "https://github.com/astral-sh/python-build-standalone/releases/download",
    }),
  });
  assert.equal(mirrorOnly.status, 200);
});
