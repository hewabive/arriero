import { impliedInstanceModelId } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

test("sglang model id prefers --served-model-name", () => {
  assert.equal(
    impliedInstanceModelId({
      kind: "sglang",
      args: {
        "--served-model-name": "qwen3.5-35b",
        "--model-path": "/models/Qwen/Qwen3.5-35B-A3B-FP8",
      },
    }),
    "qwen3.5-35b",
  );
});

test("sglang model id falls back to the --model-path tail", () => {
  assert.equal(
    impliedInstanceModelId({
      kind: "sglang",
      args: { "--model-path": "/models/Qwen/Qwen3.5-35B-A3B-FP8" },
    }),
    "Qwen3.5-35B-A3B-FP8",
  );
});

test("sglang model id honours the --model alias", () => {
  assert.equal(
    impliedInstanceModelId({
      kind: "sglang",
      args: { "--model": "Qwen/Qwen3.5-35B-A3B-FP8" },
    }),
    "Qwen3.5-35B-A3B-FP8",
  );
});

test("sglang model id is null without a model", () => {
  assert.equal(impliedInstanceModelId({ kind: "sglang", args: {} }), null);
});
