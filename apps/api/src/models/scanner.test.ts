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

import { scanModels, scanModelsFromCache } from "./scanner.js";

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
    assert.equal(full.fromCache, true);
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
