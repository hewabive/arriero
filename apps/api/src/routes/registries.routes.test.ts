import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { resetSettingsCache } from "../settings/store.js";
import { registerRegistryRoutes } from "./registries.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerRegistryRoutes(app);
  return app;
}

beforeEach(() => {
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

test("package registries default to the public npm registry", async () => {
  const response = await appWithRoutes().request("/api/registries");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { npmRegistryUrl: null },
  });
});

test("package registries persist next to other settings sections", async () => {
  const app = appWithRoutes();
  const settings = {
    npmRegistryUrl: "https://npm.example/registry",
  } as const;
  const response = await app.request("/api/registries", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: settings });
  const stored = JSON.parse(readFileSync(config.settingsFile, "utf8")) as {
    registries: unknown;
    modelScan: unknown;
  };
  assert.deepEqual(stored.registries, settings);
  assert.deepEqual(stored.modelScan, { directory: "/models", maxDepth: 4 });
});

test("package registries reject credentials and non-http protocols", async () => {
  const app = appWithRoutes();
  for (const npmRegistryUrl of [
    "https://user:secret@npm.example/registry",
    "file:///srv/npm",
    "not-a-url",
  ]) {
    const response = await app.request("/api/registries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ npmRegistryUrl }),
    });
    assert.equal(response.status, 400);
  }
});
