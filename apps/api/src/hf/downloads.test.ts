import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { registerActiveJob, resetActiveJobs } from "../jobs/registry.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import {
  deleteHfDownload,
  HF_DOWNLOAD_JOB_DOMAIN,
  HfDownloadBusyError,
  HfDownloadNotFoundError,
  invalidateHfDownloadsCache,
  listHfDownloads,
} from "./downloads.js";
import { writeHfManifest } from "./manifest.js";

let scanDir = "";

function seedRepo(repoId: string, files: { path: string; present: boolean }[]) {
  const dir = join(scanDir, ...repoId.split("/"));
  mkdirSync(dir, { recursive: true });
  writeHfManifest(dir, {
    version: 1,
    repoId,
    revision: "a".repeat(40),
    downloadedAt: "2026-08-17T00:00:00.000Z",
    files: files.map((file) => ({
      path: file.path,
      size: 10,
      oid: `oid-${file.path}`,
      lfsOid: null,
      lastCommitId: null,
      lastCommitDate: null,
    })),
  });
  for (const file of files) {
    if (file.present) {
      writeFileSync(join(dir, file.path), "x".repeat(10), "utf8");
    }
  }
  return dir;
}

beforeEach(() => {
  resetActiveJobs();
  if (scanDir) {
    rmSync(scanDir, { recursive: true, force: true });
  }
  scanDir = join(config.runtimeDir, `hf-downloads-test-${randomUUID()}`);
  mkdirSync(scanDir, { recursive: true });
  saveModelScanSettings({ directory: scanDir, maxDepth: 4 });
  invalidateHfDownloadsCache();
});

test("discovery finds manifests under the scan roots", async () => {
  seedRepo("owner/repo", [
    { path: "model.gguf", present: true },
    { path: "config.json", present: false },
  ]);
  const downloads = await listHfDownloads();
  assert.equal(downloads.length, 1);
  const repo = downloads[0];
  assert.equal(repo?.repoId, "owner/repo");
  assert.equal(repo?.fileCount, 2);
  assert.equal(repo?.totalBytes, 20);
  assert.equal(repo?.missingFiles, 1);
  assert.equal(repo?.update.status, "unchecked");
  assert.equal(
    repo?.files.find((file) => file.path === "model.gguf")?.present,
    true,
  );
  assert.equal(
    repo?.files.find((file) => file.path === "config.json")?.present,
    false,
  );
});

test("list exposes gguf variants grouped from the manifest", async () => {
  seedRepo("owner/quants", [
    { path: "model-Q4_K_S.gguf", present: true },
    { path: "mmproj-F16.gguf", present: true },
    { path: "README.md", present: true },
  ]);
  const downloads = await listHfDownloads();
  const repo = downloads[0];
  assert.equal(repo?.variants?.length, 2);
  assert.equal(repo?.variants?.[0]?.label, "Q4_K_S");
  assert.equal(repo?.variants?.[0]?.kind, "model");
  assert.equal(repo?.variants?.[1]?.kind, "mmproj");
});

test("list reports null variants for a repo without gguf files", async () => {
  seedRepo("owner/plain", [{ path: "config.json", present: true }]);
  const downloads = await listHfDownloads();
  assert.equal(downloads[0]?.variants, null);
});

test("delete removes the repo directory and refuses unknown dirs", async () => {
  const dir = seedRepo("owner/repo", [{ path: "model.gguf", present: true }]);
  deleteHfDownload(dir);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(scanDir, "owner")), false);
  assert.deepEqual(await listHfDownloads(), []);
  assert.throws(
    () => deleteHfDownload(join(scanDir, "missing")),
    HfDownloadNotFoundError,
  );
});

test("delete refuses while a download job is active for the repo", () => {
  const dir = seedRepo("owner/repo", [{ path: "model.gguf", present: true }]);
  registerActiveJob({
    domain: HF_DOWNLOAD_JOB_DOMAIN,
    entityId: "owner/repo",
    jobId: "job-1",
    cancel: () => {},
    completion: new Promise(() => {}),
  });
  try {
    assert.throws(() => deleteHfDownload(dir), HfDownloadBusyError);
  } finally {
    resetActiveJobs();
  }
  assert.equal(existsSync(dir), true);
});
