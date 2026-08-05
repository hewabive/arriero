import assert from "node:assert/strict";
import test from "node:test";

import { loadArgumentRegistry } from "./registry.js";
import type { LlamaArgumentEstimation } from "./estimation.js";

function estimationOf(name: string): LlamaArgumentEstimation | null {
  const entry = loadArgumentRegistry().find((candidate) =>
    candidate.option.names.includes(name),
  );
  return entry?.estimation ?? null;
}

test("estimation classes cover the known non-estimable llama-server arguments", () => {
  assert.equal(estimationOf("--help"), "exits");
  assert.equal(estimationOf("--version"), "exits");
  assert.equal(estimationOf("--list-devices"), "exits");
  assert.equal(estimationOf("--gpt-oss-20b-default"), "preset-rewrite");
  assert.equal(estimationOf("--fim-qwen-7b-spec"), "preset-rewrite");
  assert.equal(estimationOf("-hf"), "remote-selector");
  assert.equal(estimationOf("--model-url"), "remote-selector");
  assert.equal(estimationOf("--docker-repo"), "remote-selector");
  assert.equal(estimationOf("-mmu"), "remote-mmproj");
  assert.equal(estimationOf("--hf-repo-draft"), "remote-draft");
  assert.equal(estimationOf("--models-preset"), "router");
  assert.equal(estimationOf("--models-dir"), "router");
  assert.equal(estimationOf("--model-vocoder"), "normal");
  assert.equal(estimationOf("-hfv"), "normal");
  assert.equal(estimationOf("--hf-file-v"), "normal");
  assert.equal(estimationOf("--tts-use-guide-tokens"), "normal");
  assert.equal(estimationOf("--ctx-size"), "normal");
  assert.equal(estimationOf("--model"), "normal");
});

test("every registry entry carries a parsed estimation class", () => {
  const entries = loadArgumentRegistry();
  assert.ok(entries.length > 200);
  const byClass = new Map<LlamaArgumentEstimation, number>();
  for (const entry of entries) {
    byClass.set(entry.estimation, (byClass.get(entry.estimation) ?? 0) + 1);
  }
  assert.equal(byClass.get("exits"), 5);
  assert.equal(byClass.get("preset-rewrite"), 11);
  assert.equal(byClass.get("remote-selector"), 3);
  assert.equal(byClass.get("remote-mmproj"), 1);
  assert.equal(byClass.get("remote-draft"), 1);
  assert.equal(byClass.get("router"), 2);
});
