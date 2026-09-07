import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { config } from "../config.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import { checkHfDownloadIntegrity } from "./downloads.js";
import {
  startHfIntegrityJob,
  getHfIntegrityJob,
  cancelHfIntegrityJob,
} from "./integrity-jobs.js";
import { readHfManifest, writeHfManifest } from "./manifest.js";

async function fixture() {
  const dir = join(config.runtimeDir, `integrity-progress-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  saveModelScanSettings({ directory: dir, maxDepth: 4 });
  const content = Buffer.alloc(8 * 1024 * 1024, 37);
  await writeFile(join(dir, "model.gguf"), content);
  writeHfManifest(dir, {
    version: 1,
    repoId: "owner/progress",
    revision: "a".repeat(40),
    downloadedAt: new Date().toISOString(),
    files: [
      {
        path: "model.gguf",
        size: content.length,
        oid: "pointer",
        lfsOid: createHash("sha256").update(content).digest("hex"),
        lastCommitId: null,
        lastCommitDate: null,
      },
      {
        path: "missing.gguf",
        size: 123,
        oid: "pointer",
        lfsOid: "a".repeat(64),
        lastCommitId: null,
        lastCommitDate: null,
      },
    ],
  });
  return dir;
}

test("background integrity is discoverable, deduplicated and counts missing files without reading them", async () => {
  const dir = await fixture();
  try {
    const job = startHfIntegrityJob(dir);
    assert.equal(startHfIntegrityJob(dir).id, job.id);
    assert.equal(getHfIntegrityJob(dir)?.id, job.id);
    const deadline = Date.now() + 5000;
    let progressed = false;
    while (job.status === "running" && Date.now() < deadline) {
      progressed ||= !!job.verification?.processedBytes;
      await setTimeout(1);
    }
    assert.equal(job.status, "succeeded");
    assert.ok(progressed);
    assert.equal(job.completedFiles, 2);
    assert.equal(job.completedBytes, job.totalBytes);
    assert.equal(job.verification, null);
    assert.equal(job.result?.status, "issues");
    assert.deepEqual(
      job.result?.files.map((file) => file.status),
      ["verified", "missing"],
    );
    const manifest = readHfManifest(dir)!;
    writeHfManifest(dir, { ...manifest, files: manifest.files.slice(0, 1) });
    assert.equal(getHfIntegrityJob(dir)?.result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canceling during hashing leaves integrity metadata unchanged and a new job can run", async () => {
  const dir = await fixture();
  try {
    const original = readHfManifest(dir);
    const controller = new AbortController();
    await assert.rejects(
      checkHfDownloadIntegrity(dir, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress?.processedBytes) controller.abort();
        },
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(readHfManifest(dir), original);
    const canceled = startHfIntegrityJob(dir);
    cancelHfIntegrityJob(canceled.id);
    const deadline = Date.now() + 5000;
    while (canceled.status === "running" && Date.now() < deadline)
      await setTimeout(1);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.result, null);
    assert.deepEqual(readHfManifest(dir), original);
    const retry = startHfIntegrityJob(dir);
    assert.notEqual(retry.id, canceled.id);
    while (retry.status === "running" && Date.now() < deadline)
      await setTimeout(1);
    assert.equal(retry.status, "succeeded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
