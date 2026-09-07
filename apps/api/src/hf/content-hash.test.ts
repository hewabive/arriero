import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FileVerificationProgress } from "@arriero/core";
import { hashHfContentFile } from "./content-hash.js";
import { hashImportFile } from "./import-content.js";

test("hashing reports byte progress within a file without changing either digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hash-progress-"));
  try {
    const path = join(dir, "weights");
    const content = Buffer.alloc(1024 * 1024, 17);
    await writeFile(path, content);
    for (const lfs of [true, false]) {
      const samples: FileVerificationProgress[] = [];
      const digest = await hashHfContentFile(
        path,
        content.length,
        lfs,
        undefined,
        (progress) => {
          if (progress) samples.push(progress);
        },
      );
      const expected = createHash(lfs ? "sha256" : "sha1");
      if (!lfs) expected.update(`blob ${content.length}\0`);
      expected.update(content);
      assert.equal(digest, expected.digest("hex"));
      assert.equal(samples[0]?.processedBytes, 0);
      assert.equal(samples.at(-1)?.processedBytes, content.length);
      assert.ok(
        samples.some(
          (sample) =>
            sample.processedBytes > 0 && sample.processedBytes < content.length,
        ),
      );
      assert.ok(
        samples.every(
          (sample, index) =>
            sample.path === path &&
            sample.totalBytes === content.length &&
            sample.processedBytes >= (samples[index - 1]?.processedBytes ?? 0),
        ),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canceling mid-file stops hashing and does not populate the import cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hash-cancel-"));
  try {
    const path = join(dir, "weights");
    const content = Buffer.alloc(1024 * 1024, 23);
    await writeFile(path, content);
    const controller = new AbortController();
    let cleared = false;
    await assert.rejects(
      hashImportFile(
        path,
        content.length,
        true,
        controller.signal,
        (progress) => {
          if (progress?.processedBytes) controller.abort();
          if (progress === null) cleared = true;
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(cleared, true);
    let reads = 0;
    await hashImportFile(path, content.length, true, undefined, (progress) => {
      if (progress) reads++;
    });
    assert.ok(reads > 0);
    reads = 0;
    await hashImportFile(path, content.length, true, undefined, () => {
      reads++;
    });
    assert.equal(reads, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
