import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeUv } from "./uv.js";

test("environment uv compatibility does not enforce a minimum version", () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-uv-version-"));
  const uv = join(directory, "uv");
  try {
    writeFileSync(uv, '#!/bin/sh\necho "uv 0.1.0"\n', { mode: 0o755 });
    assert.deepEqual(probeUv(directory), {
      path: uv,
      version: "uv 0.1.0",
      error: null,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
