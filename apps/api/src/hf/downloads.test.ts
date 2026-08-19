import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { registerActiveJob, resetActiveJobs } from "../jobs/registry.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import {
  deleteHfDownload,
  HF_DOWNLOAD_JOB_DOMAIN,
  HfDownloadBusyError,
  HfDownloadNotFoundError,
  HfDownloadVerifyError,
  invalidateHfDownloadsCache,
  listHfDownloads,
  verifyHfDownloadRedownloadable,
} from "./downloads.js";
import { writeHfManifest } from "./manifest.js";
import { resetHfUpdateChecksForTests } from "./update-check.js";

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
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x".repeat(10), "utf8");
    }
  }
  return dir;
}

function upstreamFetch(input: {
  sha: string;
  files: { path: string; oid: string }[];
}): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).includes("/paths-info/")) {
      return new Response(
        JSON.stringify(
          input.files.map((file) => ({
            type: "file",
            path: file.path,
            oid: file.oid,
            size: 10,
          })),
        ),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ sha: input.sha }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  resetActiveJobs();
  resetHfUpdateChecksForTests();
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

test("per-file delete removes files, part leftovers and manifest entries", async () => {
  const dir = seedRepo("owner/repo", [
    { path: "model-Q4_K_M.gguf", present: true },
    { path: "model-Q8_0.gguf", present: true },
    { path: "config.json", present: true },
  ]);
  writeFileSync(join(dir, "model-Q4_K_M.gguf.part"), "partial", "utf8");
  deleteHfDownload(dir, ["model-Q4_K_M.gguf"]);
  assert.equal(existsSync(join(dir, "model-Q4_K_M.gguf")), false);
  assert.equal(existsSync(join(dir, "model-Q4_K_M.gguf.part")), false);
  assert.equal(existsSync(join(dir, "model-Q8_0.gguf")), true);
  const downloads = await listHfDownloads();
  assert.deepEqual(
    downloads[0]?.files.map((file) => file.path),
    ["model-Q8_0.gguf", "config.json"],
  );
});

test("per-file delete prunes emptied subdirectories", () => {
  const dir = seedRepo("owner/subdir", [
    { path: "Q4_K_M/model.gguf", present: true },
    { path: "README.md", present: true },
  ]);
  deleteHfDownload(dir, ["Q4_K_M/model.gguf"]);
  assert.equal(existsSync(join(dir, "Q4_K_M")), false);
  assert.equal(existsSync(join(dir, "README.md")), true);
});

test("per-file delete covering every file removes the directory", () => {
  const dir = seedRepo("owner/full", [
    { path: "a.gguf", present: true },
    { path: "b.gguf", present: true },
  ]);
  deleteHfDownload(dir, ["a.gguf", "b.gguf"]);
  assert.equal(existsSync(dir), false);
});

test("per-file delete refuses paths outside the manifest", () => {
  const dir = seedRepo("owner/guard", [{ path: "a.gguf", present: true }]);
  assert.throws(
    () => deleteHfDownload(dir, ["a.gguf", "other.gguf"]),
    HfDownloadNotFoundError,
  );
  assert.equal(existsSync(join(dir, "a.gguf")), true);
});

test("verify passes for targeted files still available upstream", async () => {
  const dir = seedRepo("owner/verify", [
    { path: "keep.gguf", present: true },
    { path: "gone.gguf", present: true },
  ]);
  const fetchImpl = upstreamFetch({
    sha: "b".repeat(40),
    files: [{ path: "keep.gguf", oid: "changed-upstream" }],
  });
  await verifyHfDownloadRedownloadable(dir, ["keep.gguf"], {
    fetchImpl,
    token: null,
  });
  await assert.rejects(
    verifyHfDownloadRedownloadable(dir, ["gone.gguf"], {
      fetchImpl,
      token: null,
    }),
    (error: unknown) =>
      error instanceof HfDownloadVerifyError &&
      error.verification.files.some(
        (file) => file.path === "gone.gguf" && file.status === "deleted",
      ),
  );
});

test("verify without paths blocks when any manifest file is gone upstream", async () => {
  const dir = seedRepo("owner/verify-all", [
    { path: "keep.gguf", present: true },
    { path: "gone.gguf", present: true },
  ]);
  const fetchImpl = upstreamFetch({
    sha: "b".repeat(40),
    files: [{ path: "keep.gguf", oid: "oid-keep.gguf" }],
  });
  await assert.rejects(
    verifyHfDownloadRedownloadable(dir, undefined, { fetchImpl, token: null }),
    HfDownloadVerifyError,
  );
});

test("verify reports an error when the upstream check fails", async () => {
  const dir = seedRepo("owner/verify-err", [{ path: "a.gguf", present: true }]);
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  await assert.rejects(
    verifyHfDownloadRedownloadable(dir, ["a.gguf"], { fetchImpl, token: null }),
    (error: unknown) =>
      error instanceof HfDownloadVerifyError &&
      /network down/.test(error.message),
  );
});

test("delete refuses while a download job is active for the directory", () => {
  const dir = seedRepo("owner/repo", [{ path: "model.gguf", present: true }]);
  registerActiveJob({
    domain: HF_DOWNLOAD_JOB_DOMAIN,
    entityId: dir,
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
