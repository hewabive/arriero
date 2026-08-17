import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { config } from "../config.js";
import {
  hfManifestPath,
  readHfManifest,
  upsertHfManifestFile,
  writeHfManifest,
  type HfManifestFile,
} from "./manifest.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = join(config.runtimeDir, `hf-manifest-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(path: string, oid = "abc"): HfManifestFile {
  return {
    path,
    size: 10,
    oid,
    lfsOid: null,
    lastCommitId: null,
    lastCommitDate: null,
  };
}

test("manifest roundtrips through write and read", () => {
  const dir = tempDir();
  const manifest = {
    version: 1 as const,
    repoId: "owner/repo",
    revision: "a".repeat(40),
    downloadedAt: "2026-08-17T00:00:00.000Z",
    files: [entry("model.gguf")],
  };
  writeHfManifest(dir, manifest);
  assert.deepEqual(readHfManifest(dir), manifest);
});

test("missing or invalid manifest reads as null", () => {
  const dir = tempDir();
  assert.equal(readHfManifest(dir), null);
  writeFileSync(hfManifestPath(dir), "{not json", "utf8");
  assert.equal(readHfManifest(dir), null);
  writeFileSync(hfManifestPath(dir), JSON.stringify({ version: 99 }), "utf8");
  assert.equal(readHfManifest(dir), null);
});

test("upsert replaces the entry with the same path", () => {
  const dir = tempDir();
  upsertHfManifestFile(
    dir,
    { repoId: "owner/repo", revision: "a".repeat(40) },
    entry("b.gguf", "first"),
  );
  upsertHfManifestFile(
    dir,
    { repoId: "owner/repo", revision: "b".repeat(40) },
    entry("a.gguf"),
  );
  const manifest = upsertHfManifestFile(
    dir,
    { repoId: "owner/repo", revision: "b".repeat(40) },
    entry("b.gguf", "second"),
  );
  assert.equal(manifest.revision, "b".repeat(40));
  assert.deepEqual(
    manifest.files.map((file) => [file.path, file.oid]),
    [
      ["a.gguf", "abc"],
      ["b.gguf", "second"],
    ],
  );
  assert.deepEqual(readHfManifest(dir), manifest);
});
