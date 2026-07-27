import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  hasLegacyModelVisibility,
  migrateModelVisibility,
} from "./models-visibility-migration.js";

const MODELS_PATH = resolve(config.proxyConfigDir, "models.json");

function writeModels(value: unknown) {
  mkdirSync(config.proxyConfigDir, { recursive: true });
  writeFileSync(MODELS_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  resetConfigFilesCache();
}

function readModels(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(MODELS_PATH, "utf8")) as Array<
    Record<string, unknown>
  >;
}

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  resetConfigFilesCache();
});

test("moves legacy enabled (visibility) to visible and turns serving on", () => {
  writeModels([
    {
      id: "m1",
      modelId: "shown",
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      createdAt: "2026-05-30T10:00:00.000Z",
      updatedAt: "2026-05-30T10:00:00.000Z",
    },
    {
      id: "m2",
      modelId: "hidden",
      enabled: false,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      createdAt: "2026-05-30T10:00:00.000Z",
      updatedAt: "2026-05-30T10:00:00.000Z",
    },
  ]);

  assert.equal(hasLegacyModelVisibility(), true);
  migrateModelVisibility();

  const records = readModels();
  assert.deepEqual(
    records.map((record) => ({
      modelId: record.modelId,
      visible: record.visible,
      enabled: record.enabled,
    })),
    [
      { modelId: "shown", visible: true, enabled: true },
      { modelId: "hidden", visible: false, enabled: true },
    ],
  );
  assert.equal(hasLegacyModelVisibility(), false);
});

test("detects an already-migrated file as not legacy", () => {
  writeModels([
    {
      id: "m1",
      modelId: "shown",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: null,
      description: null,
      createdAt: "2026-05-30T10:00:00.000Z",
      updatedAt: "2026-05-30T10:00:00.000Z",
    },
  ]);

  assert.equal(hasLegacyModelVisibility(), false);
});

test("is a no-op when the file is absent", () => {
  assert.equal(hasLegacyModelVisibility(), false);
  migrateModelVisibility();
  assert.ok(!existsSync(MODELS_PATH));
});
