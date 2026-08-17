import type { HfTreeFile } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupHfGgufFiles } from "./grouping.js";

function file(path: string, size = 100): HfTreeFile {
  return { path, size, oid: `oid-${path}`, lfs: null };
}

test("flat quant files become separate labeled variants", () => {
  const variants = groupHfGgufFiles([
    file("Model-Q4_K_M.gguf", 10),
    file("Model-Q8_0.gguf", 20),
    file("README.md"),
  ]);
  assert.ok(variants);
  assert.deepEqual(
    variants.map((v) => [v.label, v.kind, v.totalBytes]),
    [
      ["Q4_K_M", "model", 10],
      ["Q8_0", "model", 20],
    ],
  );
});

test("split shards collapse into one complete variant", () => {
  const variants = groupHfGgufFiles([
    file("Model-Q4_K_M-00001-of-00003.gguf", 10),
    file("Model-Q4_K_M-00002-of-00003.gguf", 10),
    file("Model-Q4_K_M-00003-of-00003.gguf", 5),
  ]);
  assert.ok(variants);
  assert.equal(variants.length, 1);
  const variant = variants[0];
  assert.equal(variant?.label, "Q4_K_M");
  assert.equal(variant?.splitCount, 3);
  assert.equal(variant?.complete, true);
  assert.equal(variant?.totalBytes, 25);
  assert.equal(variant?.paths.length, 3);
});

test("missing shard marks the variant incomplete", () => {
  const variants = groupHfGgufFiles([
    file("Model-Q4_K_M-00001-of-00003.gguf"),
    file("Model-Q4_K_M-00003-of-00003.gguf"),
  ]);
  assert.equal(variants?.[0]?.complete, false);
  assert.equal(variants?.[0]?.splitCount, 3);
});

test("per-quant subfolder name wins as the label", () => {
  const variants = groupHfGgufFiles([
    file("UD-Q4_K_XL/model-00001-of-00002.gguf"),
    file("UD-Q4_K_XL/model-00002-of-00002.gguf"),
    file("BF16/model.gguf"),
  ]);
  assert.ok(variants);
  assert.deepEqual(
    variants.map((v) => [v.label, v.splitCount]),
    [
      ["BF16", null],
      ["UD-Q4_K_XL", 2],
    ],
  );
});

test("mmproj files are separated by kind", () => {
  const variants = groupHfGgufFiles([
    file("Model-Q4_K_M.gguf"),
    file("mmproj-model-f16.gguf"),
  ]);
  assert.deepEqual(
    variants?.map((v) => v.kind),
    ["model", "mmproj"],
  );
});

test("gguf without a recognizable quant label lands in other", () => {
  const variants = groupHfGgufFiles([file("adapter.gguf")]);
  assert.equal(variants?.[0]?.kind, "other");
  assert.equal(variants?.[0]?.label, null);
});

test("a repo without gguf files returns null", () => {
  assert.equal(
    groupHfGgufFiles([file("model.safetensors"), file("config.json")]),
    null,
  );
});
