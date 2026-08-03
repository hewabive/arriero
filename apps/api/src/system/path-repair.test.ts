import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  augmentProcessPath,
  autoRepairedPathDirectories,
  missingPathDirectories,
} from "./path-repair.js";

test("returns only existing directories that PATH is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "path-repair-"));

  assert.deepEqual(
    missingPathDirectories(`/usr/bin:${root}`, [
      "/usr/bin",
      root,
      join(root, "does-not-exist"),
    ]),
    [],
  );
  assert.deepEqual(missingPathDirectories("/usr/bin", [root]), [root]);
});

test("an empty PATH still filters out nonexistent candidates", () => {
  assert.deepEqual(
    missingPathDirectories(undefined, ["/definitely/not/here"]),
    [],
  );
});

test("re-checking PATH adds and remembers tools installed after startup", () => {
  const root = mkdtempSync(join(tmpdir(), "path-repair-late-"));
  const startupToolDirectory = join(root, "startup", "bin");
  const laterToolDirectory = join(root, "later", "bin");
  mkdirSync(startupToolDirectory, { recursive: true });
  mkdirSync(laterToolDirectory, { recursive: true });
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "/usr/bin";
    assert.deepEqual(augmentProcessPath([startupToolDirectory]), [
      startupToolDirectory,
    ]);
    assert.deepEqual(
      augmentProcessPath([startupToolDirectory, laterToolDirectory]),
      [laterToolDirectory],
    );
    assert.deepEqual(autoRepairedPathDirectories(), [
      startupToolDirectory,
      laterToolDirectory,
    ]);
  } finally {
    process.env.PATH = originalPath;
  }
});
