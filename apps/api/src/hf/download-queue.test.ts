import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { getActiveJob, shutdownActiveJobs } from "../jobs/registry.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { HfDownloadConflictError } from "./download-plan.js";
import {
  adoptHfDownloadQueue,
  beginHfDownloadQueueShutdown,
  cancelActiveHfDownload,
  clearHfDownloadHistory,
  enqueueHfDownload,
  getHfDownloadQueueState,
  reloadHfDownloadQueueFromStoreForTests,
  removeHfDownloadQueueJob,
  reorderHfDownloadQueue,
  resetHfDownloadQueueForTests,
  setHfDownloadQueueFallbackOptionsForTests,
  skipHfDownloadFiles,
  waitForHfDownloadQueueIdle,
} from "./download-queue.js";
import { HF_DOWNLOAD_JOB_DOMAIN } from "./downloads.js";
import { readHfManifest, writeHfManifest } from "./manifest.js";
import { HfDownloadRequestError } from "./paths.js";
import { loadHfQueueStore, persistHfQueueStore } from "./queue-store.js";
import {
  getHfUpdateCheck,
  resetHfUpdateChecksForTests,
  runHfUpdateChecks,
} from "./update-check.js";

const REPO_ID = "owner/repo";
const SHA = "c".repeat(40);

type FixtureFile = {
  content: Buffer;
  lfs: boolean;
};

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function gitBlobSha1(content: Buffer): string {
  const hash = createHash("sha1");
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest("hex");
}

type StubOptions = {
  serveRange?: boolean;
  serveContent?: Map<string, Buffer>;
  failResolveWith?: number;
  gatedPaths?: Set<string>;
};

type Stub = {
  fetchImpl: typeof fetch;
  resolveRequests: { path: string; range: string | null }[];
  releaseGate: (path: string) => void;
};

function makeStub(
  files: Map<string, FixtureFile>,
  options?: StubOptions,
): Stub {
  const resolveRequests: Stub["resolveRequests"] = [];
  const gateReleases = new Map<string, () => void>();
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.includes("/api/models/") && url.includes("/revision/")) {
      return new Response(JSON.stringify({ sha: SHA }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/paths-info/")) {
      const body = JSON.parse(String(init?.body)) as { paths: string[] };
      const entries = body.paths.flatMap((path) => {
        const file = files.get(path);
        if (!file) {
          return [];
        }
        return [
          {
            type: "file",
            path,
            size: file.lfs ? undefined : file.content.length,
            oid: file.lfs ? `git-${path}` : gitBlobSha1(file.content),
            lfs: file.lfs
              ? { oid: sha256Hex(file.content), size: file.content.length }
              : undefined,
            lastCommit: { id: SHA, date: "2026-08-17T00:00:00.000Z" },
          },
        ];
      });
      return new Response(JSON.stringify(entries), {
        headers: { "content-type": "application/json" },
      });
    }
    const resolveMatch = /\/resolve\/[^/]+\/(.+)$/.exec(url);
    if (resolveMatch) {
      const path = decodeURIComponent(resolveMatch[1] ?? "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers.range ?? null;
      resolveRequests.push({ path, range });
      if (options?.failResolveWith) {
        return new Response(JSON.stringify({ error: "denied" }), {
          status: options.failResolveWith,
          headers: { "content-type": "application/json" },
        });
      }
      const file = files.get(path);
      assert.ok(file, `unexpected resolve request for ${path}`);
      const content = options?.serveContent?.get(path) ?? file.content;
      if (options?.gatedPaths?.has(path)) {
        const signal = init?.signal;
        const firstChunk = content.subarray(0, 1);
        const rest = content.subarray(1);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from(firstChunk));
            gateReleases.set(path, () => {
              controller.enqueue(Uint8Array.from(rest));
              controller.close();
            });
            signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return new Response(body, { status: 200 });
      }
      if (range && options?.serveRange !== false) {
        const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? "0");
        return new Response(Uint8Array.from(content.subarray(offset)), {
          status: 206,
        });
      }
      return new Response(Uint8Array.from(content), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    resolveRequests,
    releaseGate: (path) => {
      gateReleases.get(path)?.();
      gateReleases.delete(path);
    },
  };
}

let destDir = "";

beforeEach(() => {
  resetHfDownloadQueueForTests();
  resetHfUpdateChecksForTests();
  saveHfDownloadSettings({ connections: 1, chunkBytes: 4 * 1024 * 1024 });
  destDir = join(config.runtimeDir, `hf-queue-test-${randomUUID()}`);
});

const nullFreeBytes = () => Promise.resolve<number | null>(null);

function stubOptions(stub: Stub) {
  return { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function historyJob(id: string) {
  const job = getHfDownloadQueueState().history.find(
    (entry) => entry.id === id,
  );
  assert.ok(job, `job ${id} not in history`);
  return job;
}

test("happy path downloads, verifies and records the manifest incrementally", async () => {
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content: randomBytes(2_048), lfs: true }],
    ["config.json", { content: Buffer.from('{"a":1}'), lfs: false }],
  ]);
  const stub = makeStub(files);
  const job = await enqueueHfDownload(
    {
      repoId: REPO_ID,
      revision: SHA,
      paths: ["model.safetensors", "config.json"],
      destDir,
    },
    stubOptions(stub),
  );
  assert.ok(job.status === "queued" || job.status === "running");
  assert.equal(job.totalBytes, 2_048 + 7);
  await waitForHfDownloadQueueIdle();

  const finished = historyJob(job.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.downloadedBytes, finished.totalBytes);
  assert.notEqual(finished.startedAt, null);
  assert.notEqual(finished.finishedAt, null);
  assert.deepEqual(
    finished.files.map((file) => file.status),
    ["succeeded", "succeeded"],
  );
  for (const [path, file] of files) {
    assert.deepEqual(readFileSync(join(destDir, path)), file.content);
  }
  const manifest = readHfManifest(destDir);
  assert.equal(manifest?.repoId, REPO_ID);
  assert.equal(manifest?.revision, SHA);
  assert.deepEqual(
    manifest?.files.map((file) => [file.path, file.lfsOid !== null]),
    [
      ["config.json", false],
      ["model.safetensors", true],
    ],
  );
  const seeded = getHfUpdateCheck(destDir);
  assert.equal(seeded.status, "in-sync");
  assert.equal(seeded.revisionSha, SHA);
  assert.notEqual(seeded.checkedAt, null);
});

test("a file already current on disk is skipped without a resolve request", async () => {
  const content = randomBytes(512);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "model.safetensors"), content);
  writeHfManifest(destDir, {
    version: 1,
    repoId: REPO_ID,
    revision: SHA,
    downloadedAt: "2026-08-17T00:00:00.000Z",
    files: [
      {
        path: "model.safetensors",
        size: content.length,
        oid: "git-model.safetensors",
        lfsOid: sha256Hex(content),
        lastCommitId: null,
        lastCommitDate: null,
      },
    ],
  });
  const stub = makeStub(files);
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    stubOptions(stub),
  );
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(job.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(
    finished.files.map((file) => file.status),
    ["skipped"],
  );
  assert.equal(stub.resolveRequests.length, 0);
});

test("a leftover part file resumes with a range request", async () => {
  const content = randomBytes(1_000);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    join(destDir, "model.safetensors.part"),
    content.subarray(0, 400),
  );
  const stub = makeStub(files);
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    stubOptions(stub),
  );
  await waitForHfDownloadQueueIdle();
  assert.equal(historyJob(job.id).status, "succeeded");
  assert.deepEqual(stub.resolveRequests, [
    { path: "model.safetensors", range: "bytes=400-" },
  ]);
  assert.deepEqual(readFileSync(join(destDir, "model.safetensors")), content);
  assert.equal(existsSync(join(destDir, "model.safetensors.part")), false);
});

test("a server that ignores the range request still produces a correct file", async () => {
  const content = randomBytes(1_000);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    join(destDir, "model.safetensors.part"),
    content.subarray(0, 400),
  );
  const stub = makeStub(files, { serveRange: false });
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    stubOptions(stub),
  );
  await waitForHfDownloadQueueIdle();
  assert.equal(historyJob(job.id).status, "succeeded");
  assert.deepEqual(readFileSync(join(destDir, "model.safetensors")), content);
});

test("a checksum mismatch fails the file and removes the part", async () => {
  const content = randomBytes(1_000);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  const stub = makeStub(files, {
    serveContent: new Map([["model.safetensors", randomBytes(1_000)]]),
  });
  await runHfUpdateChecks([destDir]);
  assert.equal(getHfUpdateCheck(destDir).status, "error");
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    stubOptions(stub),
  );
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(job.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.files[0]?.error ?? "", /checksum mismatch/);
  assert.equal(existsSync(join(destDir, "model.safetensors")), false);
  assert.equal(existsSync(join(destDir, "model.safetensors.part")), false);
  assert.deepEqual(readHfManifest(destDir)?.files, []);
  assert.equal(getHfUpdateCheck(destDir).status, "unchecked");
});

test("an unauthorized upstream fails fast and cancels the rest", async () => {
  const files = new Map<string, FixtureFile>([
    ["a.bin", { content: randomBytes(100), lfs: true }],
    ["b.bin", { content: randomBytes(100), lfs: true }],
  ]);
  const stub = makeStub(files, { failResolveWith: 401 });
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["a.bin", "b.bin"], destDir },
    stubOptions(stub),
  );
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(job.id);
  assert.equal(finished.status, "failed");
  assert.deepEqual(
    finished.files.map((file) => file.status),
    ["failed", "canceled"],
  );
  assert.equal(stub.resolveRequests.length, 1);
});

test("cancel mid-stream keeps the part file for a later resume", async () => {
  const content = randomBytes(1_000);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  const stub = makeStub(files, { gatedPaths: new Set(["model.safetensors"]) });
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    stubOptions(stub),
  );
  await waitFor(
    () => (getHfDownloadQueueState().active?.downloadedBytes ?? 0) > 0,
    "first bytes",
  );
  const canceled = cancelActiveHfDownload(job.id);
  assert.equal(canceled.ok, true);
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(job.id);
  assert.equal(finished.status, "canceled");
  assert.equal(finished.cancelRequested, true);
  assert.deepEqual(
    finished.files.map((file) => file.status),
    ["canceled"],
  );
  assert.equal(existsSync(join(destDir, "model.safetensors")), false);
  assert.deepEqual(readHfManifest(destDir)?.files, []);
});

test("insufficient free space refuses the enqueue", async () => {
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content: randomBytes(100), lfs: true }],
  ]);
  const stub = makeStub(files);
  await assert.rejects(
    enqueueHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
      {
        fetchImpl: stub.fetchImpl,
        token: null,
        freeBytes: () => Promise.resolve(1_000),
      },
    ),
    HfDownloadConflictError,
  );
  assert.equal(getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, destDir), null);
  assert.deepEqual(getHfDownloadQueueState().queued, []);
});

test("path traversal in the file list is rejected", async () => {
  const stub = makeStub(new Map());
  await assert.rejects(
    enqueueHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["../evil.bin"], destDir },
      stubOptions(stub),
    ),
    HfDownloadRequestError,
  );
  assert.equal(existsSync(join(dirname(destDir), "evil.bin")), false);
});

test("unknown paths are rejected before any download starts", async () => {
  const stub = makeStub(new Map());
  await assert.rejects(
    enqueueHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["missing.bin"], destDir },
      stubOptions(stub),
    ),
    HfDownloadRequestError,
  );
});

test("the queue runs jobs sequentially in FIFO order", async () => {
  const slow = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
  ]);
  const fast = new Map<string, FixtureFile>([
    ["fast.bin", { content: randomBytes(100), lfs: true }],
  ]);
  const slowStub = makeStub(slow, { gatedPaths: new Set(["slow.bin"]) });
  const fastStub = makeStub(fast);
  const otherDir = join(config.runtimeDir, `hf-queue-test-${randomUUID()}`);
  const first = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["slow.bin"], destDir },
    stubOptions(slowStub),
  );
  const second = await enqueueHfDownload(
    {
      repoId: "owner/other",
      revision: SHA,
      paths: ["fast.bin"],
      destDir: otherDir,
    },
    stubOptions(fastStub),
  );
  assert.equal(second.status, "queued");
  await waitFor(
    () => getHfDownloadQueueState().active?.id === first.id,
    "first job running",
  );
  const state = getHfDownloadQueueState();
  assert.deepEqual(
    state.queued.map((entry) => entry.id),
    [second.id],
  );
  assert.equal(fastStub.resolveRequests.length, 0);
  slowStub.releaseGate("slow.bin");
  await waitForHfDownloadQueueIdle();
  const done = getHfDownloadQueueState();
  assert.equal(done.active, null);
  assert.deepEqual(
    done.history.map((entry) => entry.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    done.history.map((entry) => entry.status),
    ["succeeded", "succeeded"],
  );
});

test("the same repo can be enqueued again while a job for it runs", async () => {
  const files = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
    ["extra.bin", { content: randomBytes(100), lfs: true }],
  ]);
  const stub = makeStub(files, { gatedPaths: new Set(["slow.bin"]) });
  const first = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["slow.bin"], destDir },
    stubOptions(stub),
  );
  await waitFor(
    () => getHfDownloadQueueState().active?.id === first.id,
    "first job running",
  );
  const second = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["extra.bin"], destDir },
    stubOptions(stub),
  );
  assert.equal(second.status, "queued");
  stub.releaseGate("slow.bin");
  await waitForHfDownloadQueueIdle();
  assert.deepEqual(
    getHfDownloadQueueState().history.map((entry) => entry.status),
    ["succeeded", "succeeded"],
  );
});

test("queued jobs can be reordered, removed and validated", async () => {
  const running = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
  ]);
  const stub = makeStub(running, { gatedPaths: new Set(["slow.bin"]) });
  const first = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["slow.bin"], destDir },
    stubOptions(stub),
  );
  await waitFor(
    () => getHfDownloadQueueState().active?.id === first.id,
    "first job running",
  );
  const filesB = new Map<string, FixtureFile>([
    ["b.bin", { content: randomBytes(10), lfs: false }],
  ]);
  const filesC = new Map<string, FixtureFile>([
    ["c.bin", { content: randomBytes(10), lfs: false }],
  ]);
  const jobB = await enqueueHfDownload(
    { repoId: "owner/b", revision: SHA, paths: ["b.bin"], destDir },
    stubOptions(makeStub(filesB)),
  );
  const jobC = await enqueueHfDownload(
    { repoId: "owner/c", revision: SHA, paths: ["c.bin"], destDir },
    stubOptions(makeStub(filesC)),
  );
  const badReorder = reorderHfDownloadQueue([jobB.id]);
  assert.equal(badReorder.ok, false);
  if (!badReorder.ok) {
    assert.equal(badReorder.status, 400);
  }
  const reordered = reorderHfDownloadQueue([jobC.id, jobB.id]);
  assert.equal(reordered.ok, true);
  if (reordered.ok) {
    assert.deepEqual(
      reordered.state.queued.map((entry) => entry.id),
      [jobC.id, jobB.id],
    );
  }
  const removeRunning = removeHfDownloadQueueJob(first.id);
  assert.equal(removeRunning.ok, false);
  if (!removeRunning.ok) {
    assert.equal(removeRunning.status, 409);
  }
  const removed = removeHfDownloadQueueJob(jobC.id);
  assert.equal(removed.ok, true);
  if (removed.ok) {
    assert.deepEqual(
      removed.state.queued.map((entry) => entry.id),
      [jobB.id],
    );
  }
  stub.releaseGate("slow.bin");
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(first.id);
  assert.equal(finished.status, "succeeded");
  const removedHistory = removeHfDownloadQueueJob(first.id);
  assert.equal(removedHistory.ok, true);
  assert.equal(
    getHfDownloadQueueState().history.some((entry) => entry.id === first.id),
    false,
  );
});

test("files can be skipped from a queued job and the empty job is dropped", async () => {
  const running = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
  ]);
  const stub = makeStub(running, { gatedPaths: new Set(["slow.bin"]) });
  await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["slow.bin"], destDir },
    stubOptions(stub),
  );
  const filesB = new Map<string, FixtureFile>([
    ["b1.bin", { content: randomBytes(10), lfs: false }],
    ["b2.bin", { content: randomBytes(20), lfs: false }],
  ]);
  const jobB = await enqueueHfDownload(
    { repoId: "owner/b", revision: SHA, paths: ["b1.bin", "b2.bin"], destDir },
    stubOptions(makeStub(filesB)),
  );
  const unknown = skipHfDownloadFiles(jobB.id, ["nope.bin"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.status, 404);
  }
  const skipped = skipHfDownloadFiles(jobB.id, ["b1.bin"]);
  assert.equal(skipped.ok, true);
  if (skipped.ok) {
    const queuedJob = skipped.state.queued.find(
      (entry) => entry.id === jobB.id,
    );
    assert.deepEqual(
      queuedJob?.files.map((file) => file.path),
      ["b2.bin"],
    );
    assert.equal(queuedJob?.totalBytes, 20);
  }
  const emptied = skipHfDownloadFiles(jobB.id, ["b2.bin"]);
  assert.equal(emptied.ok, true);
  if (emptied.ok) {
    assert.equal(
      emptied.state.queued.some((entry) => entry.id === jobB.id),
      false,
    );
  }
  stub.releaseGate("slow.bin");
  await waitForHfDownloadQueueIdle();
});

test("skipping files of the running job aborts the in-flight file and continues", async () => {
  const files = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
    ["mid.bin", { content: randomBytes(50), lfs: true }],
    ["tail.bin", { content: randomBytes(60), lfs: true }],
  ]);
  const stub = makeStub(files, { gatedPaths: new Set(["slow.bin"]) });
  const job = await enqueueHfDownload(
    {
      repoId: REPO_ID,
      revision: SHA,
      paths: ["slow.bin", "mid.bin", "tail.bin"],
      destDir,
    },
    stubOptions(stub),
  );
  await waitFor(
    () => (getHfDownloadQueueState().active?.downloadedBytes ?? 0) > 0,
    "first bytes of slow.bin",
  );
  const result = skipHfDownloadFiles(job.id, ["slow.bin", "tail.bin"]);
  assert.equal(result.ok, true);
  await waitForHfDownloadQueueIdle();
  const finished = historyJob(job.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(
    finished.files.map((file) => [file.path, file.status]),
    [
      ["slow.bin", "canceled"],
      ["mid.bin", "succeeded"],
      ["tail.bin", "canceled"],
    ],
  );
  assert.equal(existsSync(join(destDir, "slow.bin.part")), true);
  assert.deepEqual(
    readFileSync(join(destDir, "mid.bin")),
    files.get("mid.bin")?.content,
  );
});

test("finished jobs land in history newest-first, trimmed and clearable", async () => {
  const content = Buffer.from("tiny");
  const files = new Map<string, FixtureFile>([
    ["f.bin", { content, lfs: false }],
  ]);
  const ids: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    const job = await enqueueHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["f.bin"], destDir },
      stubOptions(makeStub(files)),
    );
    ids.push(job.id);
    await waitForHfDownloadQueueIdle();
  }
  const state = getHfDownloadQueueState();
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0]?.id, ids[20]);
  assert.equal(
    state.history.some((entry) => entry.id === ids[0]),
    false,
  );
  clearHfDownloadHistory();
  assert.deepEqual(getHfDownloadQueueState().history, []);
});

test("a persisted running job is adopted as queued and auto-resumes", async () => {
  const content = randomBytes(500);
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content, lfs: true }],
  ]);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    join(destDir, "model.safetensors.part"),
    content.subarray(0, 200),
  );
  persistHfQueueStore({
    version: 1,
    queue: [
      {
        id: "job-restart",
        repoId: REPO_ID,
        revision: SHA,
        destDir,
        status: "running",
        message: "Downloading model.safetensors",
        error: null,
        enqueuedAt: "2026-08-19T00:00:00.000Z",
        startedAt: "2026-08-19T00:00:01.000Z",
        finishedAt: null,
        cancelRequested: false,
        totalBytes: content.length,
        downloadedBytes: 0,
        files: [
          {
            path: "model.safetensors",
            size: content.length,
            status: "downloading",
            downloadedBytes: 200,
            error: null,
            oid: "git-model.safetensors",
            lfs: { oid: sha256Hex(content), size: content.length },
            lastCommitId: null,
            lastCommitDate: null,
          },
        ],
      },
    ],
    history: [],
  });
  const stub = makeStub(files);
  setHfDownloadQueueFallbackOptionsForTests({
    fetchImpl: stub.fetchImpl,
    token: null,
    freeBytes: nullFreeBytes,
  });
  reloadHfDownloadQueueFromStoreForTests();
  const adopted = adoptHfDownloadQueue();
  assert.equal(adopted.resumed, 1);
  await waitForHfDownloadQueueIdle();
  const finished = historyJob("job-restart");
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.startedAt, "2026-08-19T00:00:01.000Z");
  assert.deepEqual(stub.resolveRequests, [
    { path: "model.safetensors", range: "bytes=200-" },
  ]);
  assert.deepEqual(readFileSync(join(destDir, "model.safetensors")), content);
});

test("a shutdown abort re-persists the active job as queued with resumable files", async () => {
  const files = new Map<string, FixtureFile>([
    ["slow.bin", { content: randomBytes(300), lfs: true }],
  ]);
  const stub = makeStub(files, { gatedPaths: new Set(["slow.bin"]) });
  const job = await enqueueHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["slow.bin"], destDir },
    stubOptions(stub),
  );
  await waitFor(
    () => (getHfDownloadQueueState().active?.downloadedBytes ?? 0) > 0,
    "first bytes",
  );
  beginHfDownloadQueueShutdown();
  await shutdownActiveJobs(2_000);
  const stored = loadHfQueueStore();
  assert.equal(stored.queue[0]?.id, job.id);
  assert.equal(stored.queue[0]?.status, "queued");
  assert.equal(stored.queue[0]?.cancelRequested, false);
  assert.deepEqual(
    stored.queue[0]?.files.map((file) => file.status),
    ["pending"],
  );
  assert.equal(existsSync(join(destDir, "slow.bin.part")), true);
});
