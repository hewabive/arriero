import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  createEnvironmentSpec,
  deleteEnvironmentSpec,
  getEnvironmentMachineState,
  getEnvironmentSpec,
  pruneEnvironmentMachineState,
  resetEnvironmentRepository,
  setEnvironmentPathCatalogEntryId,
} from "./repository.js";

function resetEnvironmentFiles() {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  rmSync(ENVIRONMENTS_STATE_FILE, { force: true });
  resetEnvironmentRepository();
}

test("environment specs persist portable desired state, machine state lives aside", () => {
  resetEnvironmentFiles();
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
  assert.equal(getEnvironmentSpec(created.id)?.version, "0.24.0");
  const specsRaw = readFileSync(ENVIRONMENTS_FILE, "utf8");
  assert.equal(specsRaw.includes("pathCatalogEntryId"), false);
  assert.equal(specsRaw.includes("createdAt"), false);
  assert.equal(
    getEnvironmentMachineState(created.id)?.pathCatalogEntryId,
    null,
  );
  assert.ok(getEnvironmentMachineState(created.id)?.createdAt);

  setEnvironmentPathCatalogEntryId(created.id, "catalog-vllm");
  resetEnvironmentRepository();
  assert.equal(
    getEnvironmentMachineState(created.id)?.pathCatalogEntryId,
    "catalog-vllm",
  );
  assert.equal(deleteEnvironmentSpec(created.id), true);
  assert.equal(getEnvironmentMachineState(created.id), null);
});

test("prune drops machine-state entries whose spec is gone", () => {
  resetEnvironmentFiles();
  setEnvironmentPathCatalogEntryId("orphan-env", "catalog-orphan");
  assert.ok(getEnvironmentMachineState("orphan-env"));
  pruneEnvironmentMachineState();
  assert.equal(getEnvironmentMachineState("orphan-env"), null);
});

test("KTransformers desired state persists its matched source pair", () => {
  resetEnvironmentFiles();
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

test("legacy environment rows normalize to portable specs in memory", () => {
  resetEnvironmentFiles();
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
  assert.equal("pathCatalogEntryId" in normalized!, false);
  assert.equal("createdAt" in normalized!, false);
  assert.equal("indexUrl" in normalized!.source, false);
  assert.equal(deleteEnvironmentSpec("legacy-vllm"), true);
});
