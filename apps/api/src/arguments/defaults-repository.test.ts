import { argumentDefaultsForKind } from "@arriero/core";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { config } from "../config.js";
import { saveArgumentDefaults } from "./defaults-repository.js";

test("argument defaults are stored sorted by key", () => {
  saveArgumentDefaults({
    instance: [
      { key: "--port", value: "8080", valueType: "number" },
      { key: "--alias", value: "m", valueType: "string" },
      { key: "--ctx-size", value: "4096", valueType: "number" },
    ],
    engines: {},
    updatedAt: null,
  });

  const raw = JSON.parse(readFileSync(config.argumentDefaultsFile, "utf8")) as {
    instance: Array<{ key: string }>;
  };
  assert.deepEqual(
    raw.instance.map((item) => item.key),
    ["--alias", "--ctx-size", "--port"],
  );
});

test("engine argument defaults are normalized and empty sections dropped", () => {
  const saved = saveArgumentDefaults({
    instance: [],
    engines: {
      vllm: [
        { key: "--max-model-len", value: "", valueType: "null" },
        { key: "--kv-cache-dtype", value: "fp8", valueType: "string" },
        { key: "--kv-cache-dtype", value: "auto", valueType: "string" },
      ],
      sglang: [],
    },
    updatedAt: null,
  });

  assert.deepEqual(Object.keys(saved.engines), ["vllm"]);
  assert.deepEqual(
    saved.engines["vllm"]?.map((item) => [item.key, item.value]),
    [
      ["--kv-cache-dtype", "fp8"],
      ["--max-model-len", ""],
    ],
  );
});

test("argument defaults resolve per instance kind", () => {
  const defaults = {
    instance: [{ key: "--ctx-size", value: "", valueType: "null" as const }],
    engines: {
      vllm: [{ key: "--max-model-len", value: "", valueType: "null" as const }],
      sglang: [
        { key: "--mem-fraction-static", value: "", valueType: "null" as const },
      ],
    },
  };

  assert.deepEqual(
    argumentDefaultsForKind(defaults, "llama-server").map((item) => item.key),
    ["--ctx-size"],
  );
  assert.deepEqual(
    argumentDefaultsForKind(defaults, "vllm").map((item) => item.key),
    ["--max-model-len"],
  );
  assert.deepEqual(
    argumentDefaultsForKind(defaults, "ktransformers").map((item) => item.key),
    ["--mem-fraction-static"],
  );
  assert.deepEqual(argumentDefaultsForKind(defaults, "rpc-worker"), []);
});
