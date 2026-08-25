import { EnvironmentSpecSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";

import {
  deletePathCatalogEntry,
  getPathCatalogEntry,
  listPathCatalogEntries,
} from "../path-catalog/repository.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import { environmentEntrypoint } from "./paths.js";
import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  createEnvironmentSpec,
  deleteEnvironmentSpec,
  getEnvironmentMachineState,
  resetEnvironmentRepository,
} from "./repository.js";

test("KTransformers environment reconciles a tagged sglang catalog entry", () => {
  const spec = EnvironmentSpecSchema.parse({
    engine: "ktransformers",
    version: "0.6.3.post1",
    pythonVersion: "3.12",
    id: "kt-catalog-test",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const entry = reconcileEnvironmentCatalog(spec);
  assert.ok(entry);
  assert.equal(entry.engineKind, "ktransformers");
  assert.equal(entry.path, environmentEntrypoint(spec));
  assert.match(entry.name, /^KTransformers 0\.6\.3\.post1/);
  assert.equal(getPathCatalogEntry(entry.id)?.engineKind, "ktransformers");
  deletePathCatalogEntry(entry.id);
});

test("SGLang environment reconciles a tagged sglang catalog entry", () => {
  const spec = EnvironmentSpecSchema.parse({
    engine: "sglang",
    version: "0.5.17",
    pythonVersion: "3.12",
    id: "sglang-catalog-test",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const entry = reconcileEnvironmentCatalog(spec);
  assert.ok(entry);
  assert.equal(entry.engineKind, "sglang");
  assert.equal(entry.path, environmentEntrypoint(spec));
  assert.match(entry.name, /^sglang 0\.5\.17/);
  assert.equal(getPathCatalogEntry(entry.id)?.engineKind, "sglang");
  deletePathCatalogEntry(entry.id);
});

test("Open WebUI environment stays out of the path catalog", () => {
  const spec = EnvironmentSpecSchema.parse({
    engine: "open-webui",
    version: "0.11.0",
    pythonVersion: "3.12",
    id: "open-webui-catalog-test",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const before = listPathCatalogEntries("binary").length;
  const entry = reconcileEnvironmentCatalog(spec);
  assert.equal(entry, null);
  assert.equal(listPathCatalogEntries("binary").length, before);
});

test("reconcile writes the binding aside and leaves envs.json untouched", () => {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  rmSync(ENVIRONMENTS_STATE_FILE, { force: true });
  resetEnvironmentRepository();
  const created = createEnvironmentSpec({
    engine: "sglang",
    version: "0.5.17",
    variant: "cuda",
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: ["all"] },
  });
  const before = readFileSync(ENVIRONMENTS_FILE, "utf8");
  const entry = reconcileEnvironmentCatalog(created);
  assert.ok(entry);
  assert.equal(readFileSync(ENVIRONMENTS_FILE, "utf8"), before);
  assert.equal(
    getEnvironmentMachineState(created.id)?.pathCatalogEntryId,
    entry.id,
  );
  deletePathCatalogEntry(entry.id);
  deleteEnvironmentSpec(created.id);
});
