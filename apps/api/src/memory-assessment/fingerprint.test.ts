import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { artifactIdentities } from "./fingerprint.js";

const roots: string[] = [];
const runningAsRoot = process.getuid?.() === 0;

after(() => {
  for (const root of roots) {
    chmodSync(join(root, "artifacts", "sub"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

function artifactTree(): string {
  const root = mkdtempSync(join(tmpdir(), "arriero-fingerprint-"));
  roots.push(root);
  mkdirSync(join(root, "artifacts", "sub"), { recursive: true });
  writeFileSync(join(root, "artifacts", "weights.bin"), "weights");
  writeFileSync(join(root, "artifacts", "sub", "shard.bin"), "shard");
  return join(root, "artifacts");
}

test("a fully readable artifact directory reports no unreadable entries", () => {
  const identities = artifactIdentities(artifactTree());
  assert.equal(identities.length, 2);
  assert.equal(
    identities.some((identity) => identity.unreadableCount !== undefined),
    false,
  );
});

test(
  "an unreadable subdirectory changes the identities instead of vanishing",
  {
    skip: runningAsRoot ? "root bypasses directory permissions" : false,
  },
  () => {
    const directory = artifactTree();
    const readable = artifactIdentities(directory);
    chmodSync(join(directory, "sub"), 0o000);
    const degraded = artifactIdentities(directory);

    assert.notDeepEqual(degraded, readable);
    const unreadable = degraded.filter(
      (identity) => identity.unreadableCount !== undefined,
    );
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0]?.unreadableCount, 1);
    assert.equal(
      degraded.some((identity) => identity.path.endsWith("shard.bin")),
      false,
    );
  },
);
