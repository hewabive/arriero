import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { GgufModel } from "@arriero/core";

import { db } from "../db/index.js";
import { modelCache } from "../db/schema.js";
import { emptyMetadata } from "./scanner.js";
import {
  getCachedModelEntry,
  listAllCachedModels,
  pruneMissingCachedModels,
  saveCachedModel,
} from "./cache-repository.js";
import {
  GGUF_PARSER_VERSION,
  GGUF_RAW_VERSION,
  type GgufRawFacts,
} from "./gguf.js";

function model(path: string): GgufModel {
  return {
    name: "model.gguf",
    path,
    directory: dirname(path),
    sizeBytes: 1,
    modifiedAt: "2026-05-31T00:00:00.000Z",
    artifactKind: "model",
    mmprojPaths: [],
    metadata: emptyMetadata(),
  };
}

test("pruneMissingCachedModels removes cache rows for missing model files", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-"));
  const existingModel = join(dir, "model.gguf");
  const missingModel = join(dir, "deleted-model.gguf");

  try {
    writeFileSync(existingModel, "");
    saveCachedModel(model(existingModel), null);
    saveCachedModel(model(missingModel), null);

    const deleted = pruneMissingCachedModels();

    assert.ok(deleted >= 1);
    assert.ok(getCachedModelEntry(existingModel)?.model);
    assert.equal(getCachedModelEntry(missingModel), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveCachedModel refreshes parserVersion on conflict so the cache hits again", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-"));
  const path = join(dir, "stale.gguf");

  try {
    const saved = model(path);
    db.insert(modelCache)
      .values({
        path,
        name: saved.name,
        directory: saved.directory,
        sizeBytes: String(saved.sizeBytes),
        modifiedAt: saved.modifiedAt,
        isMmproj: "false",
        mmprojPathsJson: "[]",
        metadataJson: JSON.stringify(saved.metadata),
        parserVersion: GGUF_PARSER_VERSION - 1,
        error: null,
        scannedAt: saved.modifiedAt,
      })
      .run();
    assert.equal(getCachedModelEntry(path)?.model, null);

    saveCachedModel(saved, null);

    assert.ok(getCachedModelEntry(path)?.model);
    assert.ok(listAllCachedModels().some((m) => m.path === path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy cache rows derive auxiliary artifact kinds from their filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-"));
  const path = join(dir, "mtp-model.gguf");

  try {
    const saved = { ...model(path), name: "mtp-model.gguf" };
    db.insert(modelCache)
      .values({
        path,
        name: saved.name,
        directory: saved.directory,
        sizeBytes: String(saved.sizeBytes),
        modifiedAt: saved.modifiedAt,
        isMmproj: "false",
        mmprojPathsJson: "[]",
        metadataJson: JSON.stringify(saved.metadata),
        parserVersion: GGUF_PARSER_VERSION,
        error: null,
        scannedAt: saved.modifiedAt,
      })
      .run();

    assert.equal(getCachedModelEntry(path)?.model?.artifactKind, "draft-mtp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale derived layer is rebuilt from cached raw facts without reading the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-"));
  const path = join(dir, "raw.gguf");

  try {
    const saved = model(path);
    const facts: GgufRawFacts = {
      kv: [
        ["general.architecture", "qwen3"],
        ["qwen3.context_length", 4096],
        ["general.file_type", 15],
      ],
      tensors: {
        parameterCount: 1234,
        hasClassifierHead: false,
        elementsByType: [[12, 1234]],
      },
    };
    db.insert(modelCache)
      .values({
        path,
        name: saved.name,
        directory: saved.directory,
        sizeBytes: String(saved.sizeBytes),
        modifiedAt: saved.modifiedAt,
        isMmproj: "false",
        mmprojPathsJson: "[]",
        metadataJson: "{}",
        parserVersion: GGUF_PARSER_VERSION - 1,
        rawJson: JSON.stringify(facts),
        rawVersion: GGUF_RAW_VERSION,
        error: null,
        scannedAt: saved.modifiedAt,
      })
      .run();

    const entry = getCachedModelEntry(path);

    assert.equal(entry?.model?.metadata.architecture, "qwen3");
    assert.equal(entry?.model?.metadata.contextLength, 4096);
    assert.equal(entry?.model?.metadata.parameterCount, 1234);
    assert.equal(entry?.model?.metadata.quantization, "Q4_K_M");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
