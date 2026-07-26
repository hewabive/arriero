import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { missingPathDirectories } from "./path-repair.js";

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
