import assert from "node:assert/strict";
import { rmSync, utimesSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";

import type { ConfigState } from "@arriero/core";

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
