import { strict as assert } from "node:assert";
import test from "node:test";

import type { ModelPresetFile } from "@arriero/core";

import { presetFileHasErrors, validatePresetStructure } from "./validate.js";

function file(input: Partial<ModelPresetFile>): ModelPresetFile {
  return {
    globalArgs: {},
    rootArgs: {},
    entries: [],
    ...input,
  };
}

test("validatePresetStructure warns on an entry without a model source", () => {
  const diagnostics = validatePresetStructure(
    file({
      entries: [
        { id: "m", name: "m", modelPath: "", mmprojPath: null, extraArgs: {} },
      ],
    }),
  );

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.severity, "warning");
  assert.equal(diagnostics[0]!.section, "m");
  assert.match(diagnostics[0]!.message, /no model path/);
  assert.equal(presetFileHasErrors(diagnostics), false);
});

test("validatePresetStructure accepts a local model path", () => {
  const diagnostics = validatePresetStructure(
    file({
      entries: [
        {
          id: "m",
          name: "m",
          modelPath: "/m.gguf",
          mmprojPath: null,
          extraArgs: {},
        },
      ],
    }),
  );

  assert.deepEqual(diagnostics, []);
});

test("validatePresetStructure accepts a remote hf-repo source", () => {
  const diagnostics = validatePresetStructure(
    file({
      entries: [
        {
          id: "m",
          name: "m",
          modelPath: "",
          mmprojPath: null,
          extraArgs: { "hf-repo": "user/repo:Q4_K_M" },
        },
      ],
    }),
  );

  assert.deepEqual(diagnostics, []);
});
