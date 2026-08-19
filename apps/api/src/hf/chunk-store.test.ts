import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  chunkCountFor,
  chunkSizeAt,
  hfChunkSidecarPath,
  partialBytesFor,
  readHfChunkSidecar,
  removeHfChunkSidecar,
  writeHfChunkSidecar,
} from "./chunk-store.js";

let dir = "";

beforeEach(() => {
  dir = join(config.runtimeDir, `hf-chunk-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

test("chunk math covers whole and trailing chunks", () => {
  assert.equal(chunkCountFor(100, 10), 10);
  assert.equal(chunkCountFor(101, 10), 11);
  assert.equal(chunkCountFor(5, 10), 1);
  assert.equal(chunkSizeAt(101, 10, 9), 10);
  assert.equal(chunkSizeAt(101, 10, 10), 1);
});

test("a sidecar round-trips and sorts completed indexes", () => {
  const finalPath = join(dir, "model.bin");
  writeHfChunkSidecar(finalPath, {
    version: 1,
    size: 101,
    chunkBytes: 10,
    oid: "a".repeat(64),
    lfs: true,
    revision: "b".repeat(40),
    completed: [5, 0, 10],
  });
  const sidecar = readHfChunkSidecar(finalPath);
  assert.deepEqual(sidecar?.completed, [0, 5, 10]);
  assert.equal(sidecar?.chunkBytes, 10);
  removeHfChunkSidecar(finalPath);
  assert.equal(readHfChunkSidecar(finalPath), null);
});

test("an invalid sidecar reads as null", () => {
  const finalPath = join(dir, "model.bin");
  writeFileSync(hfChunkSidecarPath(finalPath), "{not json");
  assert.equal(readHfChunkSidecar(finalPath), null);
  writeFileSync(hfChunkSidecarPath(finalPath), JSON.stringify({ version: 2 }));
  assert.equal(readHfChunkSidecar(finalPath), null);
});

test("partialBytesFor uses the chunk map for sparse parts and stat for legacy parts", () => {
  const finalPath = join(dir, "model.bin");
  const partPath = `${finalPath}.part`;
  writeFileSync(partPath, Buffer.alloc(7));
  assert.equal(partialBytesFor(finalPath), 7);
  truncateSync(partPath, 101);
  writeHfChunkSidecar(finalPath, {
    version: 1,
    size: 101,
    chunkBytes: 10,
    oid: "a".repeat(64),
    lfs: true,
    revision: "b".repeat(40),
    completed: [0, 1, 10],
  });
  assert.equal(partialBytesFor(finalPath), 21);
});

test("partialBytesFor is zero without a part file", () => {
  assert.equal(partialBytesFor(join(dir, "missing.bin")), 0);
});
