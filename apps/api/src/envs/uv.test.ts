import { ENVIRONMENT_UV_MIN_VERSION } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedUvVersionOutput } from "./uv.js";

test("environment uv compatibility accepts the tested baseline and newer versions", () => {
  assert.equal(
    isSupportedUvVersionOutput(`uv ${ENVIRONMENT_UV_MIN_VERSION}`),
    true,
  );
  assert.equal(
    isSupportedUvVersionOutput(
      `uv ${ENVIRONMENT_UV_MIN_VERSION} (build metadata)`,
    ),
    true,
  );
  assert.equal(isSupportedUvVersionOutput("uv 0.12.1"), true);
  assert.equal(isSupportedUvVersionOutput("uv 1.0.0"), true);
  assert.equal(isSupportedUvVersionOutput("uv 0.11.15"), false);
  assert.equal(isSupportedUvVersionOutput(""), false);
});
