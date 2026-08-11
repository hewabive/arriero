import type {
  EngineArgumentDeclaration,
  EngineArgumentExtract,
} from "@arriero/core";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { engineArgumentValueType } from "./engine-reference.js";
import { engineArgumentSurfaceHash } from "./help-source.js";

function declaration(
  option: Partial<EngineArgumentDeclaration>,
): EngineArgumentDeclaration {
  return {
    flags: ["--flag"],
    group: null,
    help: "",
    choices: null,
    type: null,
    default: null,
    action: null,
    hidden: false,
    origin: "vllm/config/model.py:ModelConfig.field",
    ...option,
  };
}

function extract(options: EngineArgumentDeclaration[]): EngineArgumentExtract {
  return {
    schema: 1,
    engine: "vllm",
    entrypoint: "vllm serve",
    sourceFiles: ["vllm/engine/arg_utils.py"],
    options,
  };
}

describe("engineArgumentValueType", () => {
  it("maps a declared int to a number control", () => {
    assert.equal(
      engineArgumentValueType(
        declaration({ flags: ["--data-parallel-size-local"], type: "int" }),
      ),
      "number",
    );
  });

  it("maps a declared float to a number control", () => {
    assert.equal(
      engineArgumentValueType(
        declaration({ flags: ["--gpu-memory-utilization"], type: "float" }),
      ),
      "number",
    );
  });

  it("keeps a bare store_true argument a flag despite its declared bool", () => {
    assert.equal(
      engineArgumentValueType(
        declaration({ type: "bool", action: "'store_true'" }),
      ),
      "flag",
    );
  });

  it("prefers declared choices over the declared type", () => {
    assert.equal(
      engineArgumentValueType(
        declaration({ type: "str", choices: ["auto", "half", "bfloat16"] }),
      ),
      "enum",
    );
  });

  it("falls back to the literal default when no type is declared", () => {
    assert.equal(
      engineArgumentValueType(
        declaration({ default: { kind: "literal", value: 8 } }),
      ),
      "number",
    );
  });
});

describe("engine argument surface hash", () => {
  it("changes when the declared type changes", () => {
    assert.notEqual(
      engineArgumentSurfaceHash(extract([declaration({ type: "int" })])),
      engineArgumentSurfaceHash(extract([declaration({ type: "str" })])),
    );
  });
});
