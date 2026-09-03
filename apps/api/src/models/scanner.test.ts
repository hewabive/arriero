import type { ModelScanRoot } from "@arriero/core";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { modelCache, safetensorsCache } from "../db/schema.js";
import { writeHfManifest } from "../hf/manifest.js";
import { GGUF_PARSER_VERSION } from "./gguf.js";
import { SAFETENSORS_PARSER_VERSION } from "./safetensors.js";
import { scanModels, scanModelsFromCache } from "./scanner.js";

function u32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function ggufString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function root(path: string): ModelScanRoot {
  return {
    path,
    label: "test",
    source: "settings",
    refId: null,
    exists: existsSync(path),
  };
}

test("scanModels skips roots that do not exist", async () => {
  const missing = join(tmpdir(), `arriero-missing-model-dir-${Date.now()}`);

  const result = await scanModels({ roots: [root(missing)], refresh: true });
  assert.deepEqual(result.models, []);
  assert.equal(result.roots[0]?.exists, false);
});

test("scanModels collapses split GGUF shards into a single model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-scan-"));

  try {
    const nested = join(dir, "aaa-nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "zeta.gguf"), "eeeee");
    writeFileSync(join(dir, "alpha-00001-of-00003.gguf"), "a");
    writeFileSync(join(dir, "alpha-00002-of-00003.gguf"), "bb");
    writeFileSync(join(dir, "alpha-00003-of-00003.gguf"), "ccc");
    writeFileSync(join(dir, "beta.gguf"), "dddd");

    const result = await scanModels({ roots: [root(dir)], refresh: true });

    assert.deepEqual(
      result.models.map((model) => model.name),
      ["alpha-00001-of-00003.gguf", "beta.gguf", "zeta.gguf"],
    );
    assert.equal(result.models[0]?.sizeBytes, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels classifies auxiliary GGUF artifacts by llama.cpp filename conventions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-artifacts-"));

  try {
    for (const name of [
      "model.gguf",
      "mmproj-F16.gguf",
      "mtp-model.gguf",
      "model-mtp-BF16.gguf",
      "eagle3-model.gguf",
      "dflash-model.gguf",
      "dspark-model.gguf",
      "model-imatrix.gguf",
    ]) {
      writeFileSync(join(dir, name), "invalid test fixture");
    }

    const result = await scanModels({ roots: [root(dir)], refresh: true });
    assert.deepEqual(
      Object.fromEntries(
        result.models.map((model) => [model.name, model.artifactKind]),
      ),
      {
        "dflash-model.gguf": "draft-dflash",
        "dspark-model.gguf": "draft-dspark",
        "eagle3-model.gguf": "draft-eagle3",
        "mmproj-F16.gguf": "mmproj",
        "model-imatrix.gguf": "imatrix",
        "model-mtp-BF16.gguf": "draft-mtp",
        "model.gguf": "model",
        "mtp-model.gguf": "draft-mtp",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels associates root mmproj files with nested models in an HF download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-hf-model-scan-"));

  try {
    const quantDir = join(dir, "UD-Q4_K_XL");
    mkdirSync(quantDir);
    const modelPath = join(quantDir, "model-00001-of-00002.gguf");
    const mmprojF16 = join(dir, "mmproj-F16.gguf");
    const mmprojBf16 = join(dir, "mmproj-BF16.gguf");
    writeFileSync(modelPath, "a");
    writeFileSync(join(quantDir, "model-00002-of-00002.gguf"), "bb");
    writeFileSync(mmprojF16, "ccc");
    writeFileSync(mmprojBf16, "dddd");
    writeHfManifest(dir, {
      version: 1,
      repoId: "unsloth/example-GGUF",
      revision: "a".repeat(40),
      downloadedAt: new Date().toISOString(),
      files: [],
    });

    const scanned = await scanModels({
      roots: [root(dir)],
      refresh: true,
    });
    const model = scanned.models.find((entry) => entry.path === modelPath);
    assert.deepEqual(model?.mmprojPaths, [mmprojBf16, mmprojF16].sort());

    const cached = scanModelsFromCache({ roots: [root(dir)] });
    const cachedModel = cached.models.find((entry) => entry.path === modelPath);
    assert.deepEqual(cachedModel?.mmprojPaths, [mmprojBf16, mmprojF16].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels does not inherit parent mmproj files outside HF downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-local-model-scan-"));

  try {
    const modelDir = join(dir, "Q4_K_M");
    mkdirSync(modelDir);
    const modelPath = join(modelDir, "model.gguf");
    writeFileSync(modelPath, "a");
    writeFileSync(join(dir, "mmproj-F16.gguf"), "bb");

    const scanned = await scanModels({
      roots: [root(dir)],
      refresh: true,
    });
    const model = scanned.models.find((entry) => entry.path === modelPath);
    assert.deepEqual(model?.mmprojPaths, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels skips a file that disappears between walk and stat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-scan-race-"));

  try {
    writeFileSync(join(dir, "aaa.gguf"), "a");
    writeFileSync(join(dir, "bbb.gguf"), "bb");

    let deleted = false;
    const result = await scanModels({
      roots: [root(dir)],
      refresh: true,
      onProgress: () => {
        if (!deleted) {
          deleted = true;
          rmSync(join(dir, "bbb.gguf"), { force: true });
        }
      },
    });

    assert.deepEqual(
      result.models.map((model) => model.name),
      ["aaa.gguf"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels flags truncation when a root exceeds maxFiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-scan-cap-"));

  try {
    writeFileSync(join(dir, "a.gguf"), "a");
    writeFileSync(join(dir, "b.gguf"), "b");
    writeFileSync(join(dir, "c.gguf"), "c");

    const capped = await scanModels({
      roots: [root(dir)],
      refresh: true,
      maxFiles: 2,
    });
    assert.equal(capped.truncated, true);
    assert.equal(capped.models.length, 2);

    rmSync(join(dir, "c.gguf"), { force: true });
    const exact = await scanModels({
      roots: [root(dir)],
      refresh: true,
      maxFiles: 2,
    });
    assert.equal(exact.truncated, false);
    assert.equal(exact.models.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModels merges multiple roots and dedupes nested ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-scan-"));

  try {
    const nested = join(dir, "sub");
    mkdirSync(nested);
    writeFileSync(join(dir, "top.gguf"), "a");
    writeFileSync(join(nested, "deep.gguf"), "bb");

    const result = await scanModels({
      roots: [root(dir), root(nested)],
      refresh: true,
    });

    assert.deepEqual(result.models.map((model) => model.name).sort(), [
      "deep.gguf",
      "top.gguf",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanModelsFromCache returns cached models scoped by roots and depth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-cache-scan-"));

  try {
    const nested = join(dir, "sub");
    mkdirSync(nested);
    writeFileSync(join(dir, "top.gguf"), "a");
    writeFileSync(join(nested, "deep.gguf"), "bb");
    await scanModels({ roots: [root(dir)], maxDepth: 4, refresh: true });

    const full = scanModelsFromCache({ roots: [root(dir)], maxDepth: 4 });
    assert.deepEqual(full.models.map((model) => model.name).sort(), [
      "deep.gguf",
      "top.gguf",
    ]);

    const shallow = scanModelsFromCache({ roots: [root(dir)], maxDepth: 0 });
    assert.deepEqual(
      shallow.models.map((model) => model.name),
      ["top.gguf"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function safetensorsFixture(tensors: Array<[string, string, number[]]>) {
  const header: Record<string, unknown> = {};
  for (const [name, dtype, shape] of tensors) {
    header[name] = { dtype, shape, data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length), 0);
  return Buffer.concat([length, json]);
}

test("scanModels lists safetensors dirs alongside GGUF files and serves them from cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-safetensors-scan-"));

  try {
    writeFileSync(join(dir, "plain.gguf"), "gg");
    const modelDir = join(dir, "qwen3-tiny");
    mkdirSync(modelDir);
    writeFileSync(
      join(modelDir, "model.safetensors"),
      safetensorsFixture([["a", "BF16", [4, 2]]]),
    );
    writeFileSync(
      join(modelDir, "config.json"),
      JSON.stringify({
        architectures: ["Qwen3ForCausalLM"],
        model_type: "qwen3",
        num_hidden_layers: 2,
      }),
    );

    const first = await scanModels({ roots: [root(dir)], refresh: true });
    assert.equal(first.safetensors.length, 1);
    const model = first.safetensors[0];
    assert.equal(model?.name, "qwen3-tiny");
    assert.equal(model?.path, modelDir);
    assert.equal(model?.metadata.architecture, "Qwen3ForCausalLM");
    assert.equal(model?.metadata.parameterCount, 8);
    assert.deepEqual(model?.weightFiles, ["model.safetensors"]);
    assert.deepEqual(
      first.models.map((item) => item.name),
      ["plain.gguf"],
    );

    const second = await scanModels({ roots: [root(dir)] });
    assert.deepEqual(second.cache, { hits: 2, misses: 0 });
    assert.equal(second.safetensors[0]?.metadata.modelType, "qwen3");

    const fromCache = scanModelsFromCache({ roots: [root(dir)] });
    assert.equal(fromCache.safetensors.length, 1);
    assert.equal(fromCache.safetensors[0]?.path, modelDir);

    const scoped = scanModelsFromCache({ roots: [root(dir)], maxDepth: 0 });
    assert.equal(scoped.safetensors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a safetensors parser bump rebuilds metadata from cached facts without re-reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-safetensors-derive-"));

  try {
    const modelDir = join(dir, "model-a");
    mkdirSync(modelDir);
    writeFileSync(
      join(modelDir, "model.safetensors"),
      safetensorsFixture([["a", "F16", [4]]]),
    );
    writeFileSync(
      join(modelDir, "config.json"),
      JSON.stringify({ model_type: "llama" }),
    );

    const first = await scanModels({ roots: [root(dir)], refresh: true });
    assert.equal(first.cache.misses, 1);
    assert.equal(first.safetensors[0]?.metadata.modelType, "llama");

    db.update(safetensorsCache)
      .set({
        parserVersion: SAFETENSORS_PARSER_VERSION - 1,
        metadataJson: "{}",
      })
      .where(eq(safetensorsCache.path, modelDir))
      .run();

    const second = await scanModels({ roots: [root(dir)] });
    assert.deepEqual(second.cache, { hits: 1, misses: 0 });
    assert.equal(second.safetensors[0]?.metadata.modelType, "llama");

    const third = await scanModels({ roots: [root(dir)] });
    assert.deepEqual(third.cache, { hits: 1, misses: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scan after a parser bump rebuilds metadata from cached facts without re-reading files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-model-scan-derive-"));
  const path = join(dir, "model.gguf");

  try {
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from("GGUF", "utf8"),
        u32(3),
        u64(0),
        u64(1),
        ggufString("general.architecture"),
        u32(8),
        ggufString("qwen35"),
      ]),
    );

    const first = await scanModels({ roots: [root(dir)], refresh: true });
    assert.equal(first.cache.misses, 1);
    assert.equal(first.models[0]?.metadata.architecture, "qwen35");

    db.update(modelCache)
      .set({ parserVersion: GGUF_PARSER_VERSION - 1, metadataJson: "{}" })
      .where(eq(modelCache.path, path))
      .run();

    const second = await scanModels({ roots: [root(dir)] });
    assert.deepEqual(second.cache, { hits: 1, misses: 0 });
    assert.equal(second.models[0]?.metadata.architecture, "qwen35");

    const third = await scanModels({ roots: [root(dir)] });
    assert.deepEqual(third.cache, { hits: 1, misses: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
