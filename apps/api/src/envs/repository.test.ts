import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
    variant: "cuda",
    pythonVersion: "3.12",
    source: {
      kind: "pypi",
      extras: [],
    },
  });
  assert.equal(created.pathCatalogEntryId, null);
  assert.equal(getEnvironmentSpec(created.id)?.version, "0.24.0");

  const updated = updateEnvironmentSpec(created.id, {
    pathCatalogEntryId: "catalog-vllm",
  });
  assert.equal(updated?.pathCatalogEntryId, "catalog-vllm");

  resetEnvironmentRepository();
  assert.equal(
    getEnvironmentSpec(created.id)?.pathCatalogEntryId,
    "catalog-vllm",
  );
  assert.equal(deleteEnvironmentSpec(created.id), true);
});

test("KTransformers desired state persists its matched source pair", () => {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  resetEnvironmentRepository();
  const created = createEnvironmentSpec({
    engine: "ktransformers",
    version: "0.6.3.post1",
    variant: "cuda",
    pythonVersion: "3.12",
    source: { kind: "pypi" },
  });
  assert.equal(created.engine, "ktransformers");
  assert.match(readFileSync(ENVIRONMENTS_FILE, "utf8"), /ktransformers/);
  assert.equal(deleteEnvironmentSpec(created.id), true);
});

test("legacy environment rows without engine normalize to vLLM in memory", () => {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  writeFileSync(
    ENVIRONMENTS_FILE,
    `${JSON.stringify([
      {
        version: "0.24.0",
        variant: "cuda",
        pythonVersion: "3.12",
        pythonProvisioning: "download-if-missing",
        pythonMirrorUrl: null,
        source: { kind: "pypi", extras: [], indexUrl: null },
        id: "legacy-vllm",
        pathCatalogEntryId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ])}\n`,
    "utf8",
  );
  resetEnvironmentRepository();
  const normalized = getEnvironmentSpec("legacy-vllm");
  assert.equal(normalized?.engine, "vllm");
  assert.equal("pythonProvisioning" in normalized!, false);
  assert.equal("pythonMirrorUrl" in normalized!, false);
  assert.equal("indexUrl" in normalized!.source, false);
  assert.equal(deleteEnvironmentSpec("legacy-vllm"), true);
});
