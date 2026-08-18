import { EnvironmentSpecSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import {
  deletePathCatalogEntry,
  getPathCatalogEntry,
} from "../path-catalog/repository.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import { environmentEntrypoint } from "./paths.js";

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
  assert.equal(entry.engineKind, "sglang");
  assert.equal(entry.path, environmentEntrypoint(spec));
  assert.match(entry.name, /^sglang 0\.5\.17/);
  assert.equal(getPathCatalogEntry(entry.id)?.engineKind, "sglang");
  deletePathCatalogEntry(entry.id);
});
