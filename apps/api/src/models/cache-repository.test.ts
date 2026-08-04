import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { GgufModel } from "@arriero/core";

import { db } from "../db/index.js";
import { modelCache } from "../db/schema.js";
import {
  getCachedModel,
  listAllCachedModels,
  pruneMissingCachedModels,
  saveCachedModel,
} from "./cache-repository.js";
import { GGUF_PARSER_VERSION } from "./gguf.js";

function model(path: string): GgufModel {
  return {
    name: "model.gguf",
    path,
    directory: dirname(path),
    sizeBytes: 1,
    modifiedAt: "2026-05-31T00:00:00.000Z",
    isMmproj: false,
    mmprojPaths: [],
    metadata: {
      name: null,
      architecture: null,
      modelType: null,
      poolingType: null,
      causalAttention: null,
      hasClassifierHead: false,
      quantization: null,
      quantizationVersion: null,
      sizeLabel: null,
      basename: null,
      finetune: null,
      license: null,
      licenseLink: null,
      repoUrl: null,
      version: null,
      quantizedBy: null,
      tags: [],
      baseModels: [],
      parameterCount: null,
      contextLength: null,
      embeddingLength: null,
      blockCount: null,
      leadingDenseBlockCount: null,
      feedForwardLength: null,
      expertCount: null,
      expertUsedCount: null,
      expertSharedCount: null,
      expertFeedForwardLength: null,
      headCount: null,
      headCountKv: null,
      attentionKeyLength: null,
      attentionValueLength: null,
      attentionKeyLengthMla: null,
      attentionValueLengthMla: null,
      slidingWindow: null,
      slidingWindowPattern: null,
      sharedKvLayers: null,
      ssmConvKernel: null,
      ssmGroupCount: null,
      ssmInnerSize: null,
      ssmStateSize: null,
      wkvHeadSize: null,
      tokenShiftCount: null,
      ropeFreqBase: null,
      ropeScalingType: null,
      ropeScalingFactor: null,
      ropeScalingOrigCtxLen: null,
      tokenizerModel: null,
      tokenizerPre: null,
      addBosToken: null,
      addEosToken: null,
      hasChatTemplate: false,
      vocabularySize: null,
      samplingTemp: null,
      samplingTopK: null,
      samplingTopP: null,
      imatrixDataset: null,
      imatrixEntries: null,
      imatrixChunks: null,
    },
  };
}

test("pruneMissingCachedModels removes cache rows for missing model files", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-"));
  const existingModel = join(dir, "model.gguf");
  const missingModel = join(dir, "deleted-model.gguf");

  try {
    writeFileSync(existingModel, "");
    saveCachedModel(model(existingModel));
    saveCachedModel(model(missingModel));

    const deleted = pruneMissingCachedModels();

    assert.ok(deleted >= 1);
    assert.ok(getCachedModel(existingModel));
    assert.equal(getCachedModel(missingModel), null);
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
    assert.equal(getCachedModel(path), null);

    saveCachedModel(saved);

    assert.ok(getCachedModel(path));
    assert.ok(listAllCachedModels().some((m) => m.path === path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
