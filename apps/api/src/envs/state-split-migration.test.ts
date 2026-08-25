import { EnvironmentMachineStateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import { normalizeConfigFiles } from "../config-normalize.js";
import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  getEnvironmentMachineState,
  getEnvironmentSpec,
  resetEnvironmentRepository,
} from "./repository.js";
import {
  envsStateSplitApplied,
  splitEnvironmentMachineState,
} from "./state-split-migration.js";

const legacyRows = [
  {
    engine: "vllm",
    version: "0.24.0",
    variant: "cuda",
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: [] },
    id: "legacy-a",
    pathCatalogEntryId: "catalog-a",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
  },
  {
    engine: "sglang",
    version: "0.5.17",
    variant: "cuda",
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: ["all"] },
    id: "legacy-b",
    pathCatalogEntryId: null,
    createdAt: "2026-02-03T00:00:00.000Z",
    updatedAt: "2026-02-03T00:00:00.000Z",
  },
];

function seedLegacyFile() {
  rmSync(ENVIRONMENTS_FILE, { force: true });
  rmSync(ENVIRONMENTS_STATE_FILE, { force: true });
  writeFileSync(
    ENVIRONMENTS_FILE,
    `${JSON.stringify(legacyRows, null, 2)}\n`,
    "utf8",
  );
  resetEnvironmentRepository();
}

test("split moves machine fields into envs-state.json and preserves them", () => {
  seedLegacyFile();
  assert.equal(envsStateSplitApplied(), false);
  splitEnvironmentMachineState();

  const specsRaw = readFileSync(ENVIRONMENTS_FILE, "utf8");
  assert.equal(specsRaw.includes("pathCatalogEntryId"), false);
  assert.equal(specsRaw.includes("createdAt"), false);
  const entries = EnvironmentMachineStateSchema.parse(
    JSON.parse(readFileSync(ENVIRONMENTS_STATE_FILE, "utf8")),
  );
  assert.equal(entries.length, 2);

  assert.equal(getEnvironmentSpec("legacy-a")?.engine, "vllm");
  assert.equal(
    getEnvironmentMachineState("legacy-a")?.pathCatalogEntryId,
    "catalog-a",
  );
  assert.equal(
    getEnvironmentMachineState("legacy-a")?.createdAt,
    "2026-02-01T00:00:00.000Z",
  );
  assert.equal(envsStateSplitApplied(), true);

  const stateBefore = readFileSync(ENVIRONMENTS_STATE_FILE, "utf8");
  splitEnvironmentMachineState();
  assert.equal(readFileSync(ENVIRONMENTS_STATE_FILE, "utf8"), stateBefore);
});

test("crash shape counts as applied and the normalizer converges envs.json", () => {
  seedLegacyFile();
  writeFileSync(ENVIRONMENTS_STATE_FILE, "[]\n", "utf8");
  resetEnvironmentRepository();
  assert.equal(envsStateSplitApplied(), true);

  const rewritten = normalizeConfigFiles();
  assert.ok(rewritten.includes("envs.json"));
  const specsRaw = readFileSync(ENVIRONMENTS_FILE, "utf8");
  assert.equal(specsRaw.includes("pathCatalogEntryId"), false);
  assert.equal(specsRaw.includes("updatedAt"), false);
  assert.deepEqual(normalizeConfigFiles(), []);

  rmSync(ENVIRONMENTS_FILE, { force: true });
  rmSync(ENVIRONMENTS_STATE_FILE, { force: true });
  resetEnvironmentRepository();
});
