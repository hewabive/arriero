import assert from "node:assert/strict";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";

import type { ConfigReloadResult, ConfigState } from "@arriero/core";

import {
  PATH_CATALOG_FILE,
  createPathCatalogEntry,
  listPathCatalogEntries,
  resetPathCatalogCache,
} from "../path-catalog/repository.js";
import { registerConfigRoutes } from "./config.routes.js";

async function fetchState(app: Hono): Promise<ConfigState> {
  const response = await app.request("/api/config/state");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: ConfigState };
  return body.data;
}

test("config state reports files dirty on disk", async (t) => {
  t.after(() => {
    rmSync(PATH_CATALOG_FILE, { force: true });
    resetPathCatalogCache();
  });
  const app = new Hono();
  registerConfigRoutes(app);

  rmSync(PATH_CATALOG_FILE, { force: true });
  resetPathCatalogCache();
  createPathCatalogEntry({
    kind: "binary",
    name: "state-test",
    path: "/usr/bin/llama-server",
  });
  listPathCatalogEntries();

  const clean = await fetchState(app);
  const cleanEntry = clean.files.find(
    (file) => file.storeId === "path-catalog",
  );
  assert.ok(cleanEntry);
  assert.equal(cleanEntry.dirtyOnDisk, false);
  assert.equal(clean.dirtyOnDisk, false);

  const future = new Date(Date.now() + 5_000);
  utimesSync(PATH_CATALOG_FILE, future, future);

  const dirty = await fetchState(app);
  const dirtyEntry = dirty.files.find(
    (file) => file.storeId === "path-catalog",
  );
  assert.ok(dirtyEntry);
  assert.equal(dirtyEntry.dirtyOnDisk, true);
  assert.equal(dirty.dirtyOnDisk, true);
});

test("reload validates and applies external edits without a restart", async (t) => {
  t.after(() => {
    rmSync(PATH_CATALOG_FILE, { force: true });
    resetPathCatalogCache();
  });
  const app = new Hono();
  registerConfigRoutes(app);

  rmSync(PATH_CATALOG_FILE, { force: true });
  resetPathCatalogCache();
  createPathCatalogEntry({
    kind: "binary",
    name: "before-reload",
    path: "/usr/bin/llama-server",
  });

  writeFileSync(
    PATH_CATALOG_FILE,
    `${JSON.stringify(
      [
        {
          id: "hand-written",
          kind: "binary",
          name: "after-reload",
          path: "/usr/bin/llama-server",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
  const future = new Date(Date.now() + 5_000);
  utimesSync(PATH_CATALOG_FILE, future, future);

  assert.equal(listPathCatalogEntries()[0]?.name, "before-reload");

  const response = await app.request("/api/config/reload", { method: "POST" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: ConfigReloadResult };
  assert.equal(body.data.applied, true);
  assert.deepEqual(body.data.issues, []);

  assert.equal(listPathCatalogEntries()[0]?.name, "after-reload");
  const state = await fetchState(app);
  assert.equal(state.dirtyOnDisk, false);
});

test("reload rejects an invalid tree and keeps the applied state", async (t) => {
  t.after(() => {
    rmSync(PATH_CATALOG_FILE, { force: true });
    resetPathCatalogCache();
  });
  const app = new Hono();
  registerConfigRoutes(app);

  rmSync(PATH_CATALOG_FILE, { force: true });
  resetPathCatalogCache();
  createPathCatalogEntry({
    kind: "binary",
    name: "still-here",
    path: "/usr/bin/llama-server",
  });

  writeFileSync(PATH_CATALOG_FILE, "{ definitely not json", "utf8");
  const future = new Date(Date.now() + 5_000);
  utimesSync(PATH_CATALOG_FILE, future, future);

  const response = await app.request("/api/config/reload", { method: "POST" });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: string;
    data: ConfigReloadResult;
  };
  assert.equal(body.data.applied, false);
  assert.equal(body.data.issues.length > 0, true);
  assert.equal(listPathCatalogEntries()[0]?.name, "still-here");
});
