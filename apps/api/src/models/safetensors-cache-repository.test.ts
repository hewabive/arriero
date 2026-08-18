import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { SafetensorsModel } from "@arriero/core";

import { db } from "../db/index.js";
import { safetensorsCache } from "../db/schema.js";
import {
  getCachedSafetensorsEntry,
  listAllCachedSafetensorsModels,
  pruneMissingCachedSafetensorsModels,
  saveCachedSafetensorsModel,
} from "./safetensors-cache-repository.js";
import {
  deriveSafetensorsMetadata,
  emptySafetensorsFacts,
  SAFETENSORS_PARSER_VERSION,
  SAFETENSORS_RAW_VERSION,
  type SafetensorsRawFacts,
} from "./safetensors.js";

function model(path: string): SafetensorsModel {
  return {
    name: "model-dir",
    path,
    directory: dirname(path),
    sizeBytes: 1,
    modifiedAt: "2026-05-31T00:00:00.000Z",
    weightFiles: ["model.safetensors"],
    missingShardNames: [],
    metadata: deriveSafetensorsMetadata(emptySafetensorsFacts()),
  };
}

test("pruneMissingCachedSafetensorsModels removes rows for gone or emptied dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-safetensors-cache-"));
  const liveDir = join(dir, "live");
  const emptiedDir = join(dir, "emptied");
  const goneDir = join(dir, "gone");

  try {
    mkdirSync(liveDir);
    mkdirSync(emptiedDir);
    writeFileSync(join(liveDir, "model.safetensors"), "x");
    writeFileSync(join(emptiedDir, "config.json"), "{}");

    saveCachedSafetensorsModel(model(liveDir), null);
    saveCachedSafetensorsModel(model(emptiedDir), null);
    saveCachedSafetensorsModel(model(goneDir), null);

    const deleted = pruneMissingCachedSafetensorsModels();

    assert.ok(deleted >= 2);
    assert.ok(getCachedSafetensorsEntry(liveDir));
    assert.equal(getCachedSafetensorsEntry(emptiedDir), null);
    assert.equal(getCachedSafetensorsEntry(goneDir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale derived layer is rebuilt from cached raw facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-safetensors-cache-"));
  const path = join(dir, "raw-model");

  try {
    const saved = model(path);
    const facts: SafetensorsRawFacts = {
      ...emptySafetensorsFacts(),
      config: { model_type: "qwen3", max_position_embeddings: 4096 },
      weightFiles: ["model.safetensors"],
      tensors: {
        tensorCount: 1,
        groups: [
          { suffix: "weight", dtype: "BF16", tensorCount: 1, elements: 1234 },
        ],
        prefixes: [{ prefix: "embed_tokens", tensorCount: 1, elements: 1234 }],
        packedShape: null,
      },
    };
    db.insert(safetensorsCache)
      .values({
        path,
        name: saved.name,
        directory: saved.directory,
        sizeBytes: String(saved.sizeBytes),
        modifiedAt: saved.modifiedAt,
        weightFilesJson: JSON.stringify(saved.weightFiles),
        missingShardsJson: "[]",
        metadataJson: "{}",
        parserVersion: SAFETENSORS_PARSER_VERSION - 1,
        rawJson: JSON.stringify(facts),
        rawVersion: SAFETENSORS_RAW_VERSION,
        error: null,
        scannedAt: saved.modifiedAt,
      })
      .run();

    const entry = getCachedSafetensorsEntry(path);

    assert.equal(entry?.derivedCurrent, false);
    assert.equal(entry?.model?.metadata.modelType, "qwen3");
    assert.equal(entry?.model?.metadata.contextLength, 4096);
    assert.equal(entry?.model?.metadata.parameterCount, 1234);
    assert.equal(entry?.model?.metadata.quantization, "BF16");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveCachedSafetensorsModel refreshes parserVersion so the cache hits again", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-safetensors-cache-"));
  const path = join(dir, "stale-model");

  try {
    const saved = model(path);
    db.insert(safetensorsCache)
      .values({
        path,
        name: saved.name,
        directory: saved.directory,
        sizeBytes: String(saved.sizeBytes),
        modifiedAt: saved.modifiedAt,
        weightFilesJson: JSON.stringify(saved.weightFiles),
        missingShardsJson: "[]",
        metadataJson: "{}",
        parserVersion: SAFETENSORS_PARSER_VERSION - 1,
        error: null,
        scannedAt: saved.modifiedAt,
      })
      .run();
    assert.equal(getCachedSafetensorsEntry(path)?.model, null);

    saveCachedSafetensorsModel(saved, null);

    assert.ok(getCachedSafetensorsEntry(path)?.model);
    assert.ok(listAllCachedSafetensorsModels().some((m) => m.path === path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
