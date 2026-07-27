import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getCachedArgumentCatalog,
  pruneMissingArgumentCatalogs,
  saveArgumentCatalog,
} from "./repository.js";

function catalog(binaryPath: string) {
  return {
    binaryPath,
    binarySize: 1,
    binaryMtimeMs: "1",
    binaryModifiedAt: "2026-05-31T00:00:00.000Z",
    helpHash: "test",
    options: [],
    generatedAt: "2026-05-31T00:00:00.000Z",
    parserId: "llama-help",
  };
}

test("saveArgumentCatalog round-trips the parser id", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-argument-cache-"));
  const binaryPath = join(dir, "llama-server");

  try {
    writeFileSync(binaryPath, "");
    saveArgumentCatalog(catalog(binaryPath));
    assert.equal(getCachedArgumentCatalog(binaryPath)?.parserId, "llama-help");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneMissingArgumentCatalogs removes cache rows for missing binaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-argument-cache-"));
  const existingBinary = join(dir, "llama-server");
  const missingBinary = join(dir, "deleted-llama-server");

  try {
    writeFileSync(existingBinary, "");
    saveArgumentCatalog(catalog(existingBinary));
    saveArgumentCatalog(catalog(missingBinary));

    const deleted = pruneMissingArgumentCatalogs();

    assert.ok(deleted >= 1);
    assert.ok(getCachedArgumentCatalog(existingBinary));
    assert.equal(getCachedArgumentCatalog(missingBinary), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
