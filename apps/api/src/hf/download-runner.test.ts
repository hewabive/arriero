import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { getActiveJob } from "../jobs/registry.js";
import {
  cancelHfDownload,
  getHfDownloadJob,
  HfDownloadConflictError,
  resetHfDownloadJobsForTests,
  startHfDownload,
} from "./download-runner.js";
import { HF_DOWNLOAD_JOB_DOMAIN } from "./downloads.js";
import { readHfManifest, writeHfManifest } from "./manifest.js";
import { HfDownloadRequestError } from "./paths.js";
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

function fixtureOid(file: FixtureFile): string {
  return file.lfs ? sha256Hex(file.content) : gitBlobSha1(file.content);
}

type StubOptions = {
  serveRange?: boolean;
  serveContent?: Map<string, Buffer>;
  failResolveWith?: number;
};

type Stub = {
  fetchImpl: typeof fetch;
  resolveRequests: { path: string; range: string | null }[];
};

function makeStub(
  files: Map<string, FixtureFile>,
  options?: StubOptions,
): Stub {
  const resolveRequests: Stub["resolveRequests"] = [];
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
  return { fetchImpl, resolveRequests };
}

let destDir = "";

beforeEach(() => {
  resetHfDownloadJobsForTests();
  resetHfUpdateChecksForTests();
  destDir = join(config.runtimeDir, `hf-runner-test-${randomUUID()}`);
});

async function awaitCompletion(): Promise<void> {
  await getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, REPO_ID)?.completion;
}

const nullFreeBytes = () => Promise.resolve<number | null>(null);

test("happy path downloads, verifies and records the manifest incrementally", async () => {
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content: randomBytes(2_048), lfs: true }],
    ["config.json", { content: Buffer.from('{"a":1}'), lfs: false }],
  ]);
  const stub = makeStub(files);
  const job = await startHfDownload(
    {
      repoId: REPO_ID,
      revision: SHA,
      paths: ["model.safetensors", "config.json"],
      destDir,
    },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  assert.equal(job.status, "running");
  assert.equal(job.totalBytes, 2_048 + 7);
  await awaitCompletion();

  const finished = getHfDownloadJob(REPO_ID);
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.downloadedBytes, finished?.totalBytes);
  assert.deepEqual(
    finished?.files.map((file) => file.status),
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
  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  await awaitCompletion();
  assert.equal(getHfDownloadJob(REPO_ID)?.status, "succeeded");
  assert.deepEqual(
    getHfDownloadJob(REPO_ID)?.files.map((file) => file.status),
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
  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  await awaitCompletion();
  assert.equal(getHfDownloadJob(REPO_ID)?.status, "succeeded");
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
  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  await awaitCompletion();
  assert.equal(getHfDownloadJob(REPO_ID)?.status, "succeeded");
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
  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  await awaitCompletion();
  const job = getHfDownloadJob(REPO_ID);
  assert.equal(job?.status, "failed");
  assert.match(job?.files[0]?.error ?? "", /checksum mismatch/);
  assert.equal(existsSync(join(destDir, "model.safetensors")), false);
  assert.equal(existsSync(join(destDir, "model.safetensors.part")), false);
  assert.equal(readHfManifest(destDir), null);
  assert.equal(getHfUpdateCheck(destDir).status, "unchecked");
});

test("an unauthorized upstream fails fast and cancels the rest", async () => {
  const files = new Map<string, FixtureFile>([
    ["a.bin", { content: randomBytes(100), lfs: true }],
    ["b.bin", { content: randomBytes(100), lfs: true }],
  ]);
  const stub = makeStub(files, { failResolveWith: 401 });
  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["a.bin", "b.bin"], destDir },
    { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  await awaitCompletion();
  const job = getHfDownloadJob(REPO_ID);
  assert.equal(job?.status, "failed");
  assert.deepEqual(
    job?.files.map((file) => file.status),
    ["failed", "canceled"],
  );
  assert.equal(stub.resolveRequests.length, 1);
});

test("cancel mid-stream keeps the part file for a later resume", async () => {
  const content = randomBytes(1_000);
  const firstChunk = content.subarray(0, 200);
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.includes("/paths-info/")) {
      return new Response(
        JSON.stringify([
          {
            type: "file",
            path: "model.safetensors",
            oid: "git-x",
            lfs: { oid: sha256Hex(content), size: content.length },
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(firstChunk));
        signal?.addEventListener("abort", () =>
          controller.error(new Error("aborted")),
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  await startHfDownload(
    { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
    { fetchImpl, token: null, freeBytes: nullFreeBytes },
  );
  for (let i = 0; i < 200; i += 1) {
    if ((getHfDownloadJob(REPO_ID)?.downloadedBytes ?? 0) > 0) {
      break;
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 10));
  }
  const canceled = cancelHfDownload(REPO_ID);
  assert.equal(canceled?.cancelRequested, true);
  await awaitCompletion();
  const job = getHfDownloadJob(REPO_ID);
  assert.equal(job?.status, "canceled");
  assert.deepEqual(
    job?.files.map((file) => file.status),
    ["canceled"],
  );
  assert.equal(existsSync(join(destDir, "model.safetensors")), false);
  assert.equal(readHfManifest(destDir), null);
});

test("insufficient free space refuses the download", async () => {
  const files = new Map<string, FixtureFile>([
    ["model.safetensors", { content: randomBytes(100), lfs: true }],
  ]);
  const stub = makeStub(files);
  await assert.rejects(
    startHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["model.safetensors"], destDir },
      {
        fetchImpl: stub.fetchImpl,
        token: null,
        freeBytes: () => Promise.resolve(1_000),
      },
    ),
    HfDownloadConflictError,
  );
  assert.equal(getActiveJob(HF_DOWNLOAD_JOB_DOMAIN, REPO_ID), null);
});

test("path traversal in the file list is rejected", async () => {
  const stub = makeStub(new Map());
  await assert.rejects(
    startHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["../evil.bin"], destDir },
      { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
    ),
    HfDownloadRequestError,
  );
  assert.equal(existsSync(join(dirname(destDir), "evil.bin")), false);
});

test("unknown paths are rejected before any download starts", async () => {
  const stub = makeStub(new Map());
  await assert.rejects(
    startHfDownload(
      { repoId: REPO_ID, revision: SHA, paths: ["missing.bin"], destDir },
      { fetchImpl: stub.fetchImpl, token: null, freeBytes: nullFreeBytes },
    ),
    HfDownloadRequestError,
  );
});
