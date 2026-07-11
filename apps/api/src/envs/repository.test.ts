import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import {
  ENVIRONMENTS_FILE,
  createEnvironmentSpec,
  deleteEnvironmentSpec,
  getEnvironmentSpec,
  resetEnvironmentRepository,
  updateEnvironmentSpec,
} from "./repository.js";

test("environment specs persist desired state and catalog ownership", () => {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  resetEnvironmentRepository();
  const created = createEnvironmentSpec({
    engine: "vllm",
    version: "0.24.0",
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: [], indexUrl: null },
  });
  assert.equal(created.pathCatalogEntryId, null);
  assert.equal(getEnvironmentSpec(created.id)?.version, "0.24.0");

  const updated = updateEnvironmentSpec(created.id, {
    pathCatalogEntryId: "catalog-vllm",
  });
  assert.equal(updated?.pathCatalogEntryId, "catalog-vllm");

  resetEnvironmentRepository();
  assert.equal(getEnvironmentSpec(created.id)?.pathCatalogEntryId, "catalog-vllm");
  assert.equal(deleteEnvironmentSpec(created.id), true);
});
