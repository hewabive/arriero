import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  hfChunkSidecarPath,
  partialBytesFor,
  writeHfChunkSidecar,
} from "./chunk-store.js";
import type { HfPlannedFile } from "./download-plan.js";
import type { HfManifestFile } from "./manifest.js";
import { runHfTransfer, type HfTransferResult } from "./transfer-engine.js";

const REPO_ID = "owner/repo";
const SHA = "d".repeat(40);

let destDir = "";

beforeEach(() => {
  destDir = join(config.runtimeDir, `hf-engine-test-${randomUUID()}`);
  mkdirSync(destDir, { recursive: true });
});

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function plannedFile(path: string, content: Buffer): HfPlannedFile {
  const finalPath = join(destDir, path);
  return {
    path,
    size: content.length,
    oid: `git-${path}`,
    lfs: { oid: sha256Hex(content), size: content.length },
    lastCommitId: null,
    lastCommitDate: null,
    finalPath,
    partPath: `${finalPath}.part`,
  };
}

type RangeStubOptions = {
  force200?: boolean;
  failuresByRange?: Map<string, number>;
  failStatus?: number;
  gatedRanges?: Set<string>;
  corruptRanges?: Set<string>;
  terminateAfter?: Map<string, number>;
};

function terminatingBody(slice: Buffer, deliverBytes: number): ReadableStream {
  let delivered = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(Uint8Array.from(slice.subarray(0, deliverBytes)));
        return;
      }
      controller.error(new TypeError("terminated"));
    },
  });
}

type RangeStub = {
  fetchImpl: typeof fetch;
  requests: { path: string; range: string | null }[];
  release: (range: string) => void;
};

function makeRangeStub(
  files: Map<string, Buffer>,
  options?: RangeStubOptions,
): RangeStub {
  const requests: RangeStub["requests"] = [];
  const gates = new Map<string, () => void>();
  const failures = new Map(options?.failuresByRange ?? []);
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const resolveMatch = /\/resolve\/[^/]+\/(.+)$/.exec(url);
    assert.ok(resolveMatch, `unexpected request: ${url}`);
    const path = decodeURIComponent(resolveMatch[1] ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.range ?? null;
    requests.push({ path, range });
    const content = files.get(path);
    assert.ok(content, `unexpected resolve request for ${path}`);
    const remainingFailures = range ? (failures.get(range) ?? 0) : 0;
    if (range && remainingFailures > 0) {
      failures.set(range, remainingFailures - 1);
      return new Response("upstream error", {
        status: options?.failStatus ?? 500,
      });
    }
    const bounded = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    const openEnded = range ? /^bytes=(\d+)-$/.exec(range) : null;
    const terminateBytes = options?.terminateAfter?.get(range ?? "whole");
    if (bounded && !options?.force200) {
      const start = Number(bounded[1]);
      const end = Number(bounded[2]);
      let slice = Buffer.from(content.subarray(start, end + 1));
      if (options?.corruptRanges?.has(range ?? "")) {
        slice = randomBytes(slice.length);
      }
      if (terminateBytes !== undefined) {
        return new Response(terminatingBody(slice, terminateBytes), {
          status: 206,
        });
      }
      if (options?.gatedRanges?.has(range ?? "")) {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            gates.set(range ?? "", () => {
              controller.enqueue(Uint8Array.from(slice));
              controller.close();
            });
            signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return new Response(body, { status: 206 });
      }
      return new Response(Uint8Array.from(slice), { status: 206 });
    }
    if (openEnded && !options?.force200) {
      const start = Number(openEnded[1]);
      const slice = Buffer.from(content.subarray(start));
      if (terminateBytes !== undefined) {
        return new Response(terminatingBody(slice, terminateBytes), {
          status: 206,
        });
      }
      return new Response(Uint8Array.from(slice), { status: 206 });
    }
    if (terminateBytes !== undefined) {
      return new Response(terminatingBody(content, terminateBytes), {
        status: 200,
      });
    }
    return new Response(Uint8Array.from(content), { status: 200 });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    release: (range) => {
      gates.get(range)?.();
      gates.delete(range);
    },
  };
}

type EngineRun = {
  result: Promise<HfTransferResult>;
  statuses: Map<string, string>;
  bytes: Map<string, number>;
  fileAborts: Map<string, () => void>;
  controller: AbortController;
  sleeps: number[];
};

function startEngine(
  planned: HfPlannedFile[],
  fetchImpl: typeof fetch,
  options?: {
    connections?: number;
    chunkBytes?: number;
    manifestEntries?: Map<string, HfManifestFile>;
    canceled?: Set<string>;
  },
): EngineRun {
  const statuses = new Map<string, string>();
  const bytes = new Map<string, number>();
  const fileAborts = new Map<string, () => void>();
  const controller = new AbortController();
  const sleeps: number[] = [];
  const result = runHfTransfer({
    repoId: REPO_ID,
    sha: SHA,
    planned,
    signal: controller.signal,
    clientOptions: { fetchImpl, token: null },
    manifestEntries: options?.manifestEntries ?? new Map(),
    connections: options?.connections ?? 4,
    chunkBytes: options?.chunkBytes ?? 10,
    isFileCanceled: (path) => options?.canceled?.has(path) ?? false,
    fileAborts,
    events: {
      onFileStart: (path) => statuses.set(path, "downloading"),
      onFileBytes: (path, value) => bytes.set(path, value),
      onFileFinished: (file, outcome) => statuses.set(file.path, outcome),
      onFileFailed: (path) => statuses.set(path, "failed"),
      onFileCanceled: (path) => statuses.set(path, "canceled"),
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { result, statuses, bytes, fileAborts, controller, sleeps };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a large file downloads in parallel bounded chunks and verifies", async () => {
  const content = randomBytes(100);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]));
  const run = startEngine([file], stub.fetchImpl);
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.equal(run.statuses.get("model.bin"), "succeeded");
  assert.deepEqual(readFileSync(file.finalPath), content);
  assert.equal(existsSync(file.partPath), false);
  assert.equal(existsSync(hfChunkSidecarPath(file.finalPath)), false);
  const ranges = stub.requests.map((request) => request.range).sort();
  assert.equal(ranges.length, 10);
  assert.ok(ranges.includes("bytes=0-9"));
  assert.ok(ranges.includes("bytes=90-99"));
});

test("out-of-order chunk completion still assembles a correct file", async () => {
  const content = randomBytes(50);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    gatedRanges: new Set(["bytes=0-9"]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 3 });
  await waitFor(
    () => (run.bytes.get("model.bin") ?? 0) >= 40,
    "later chunks to finish",
  );
  stub.release("bytes=0-9");
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.deepEqual(readFileSync(file.finalPath), content);
});

test("resume with a chunk sidecar fetches only the missing chunks", async () => {
  const content = randomBytes(100);
  const file = plannedFile("model.bin", content);
  writeFileSync(file.partPath, content);
  truncateSync(file.partPath, 100);
  const completed = [0, 1, 5];
  writeHfChunkSidecar(file.finalPath, {
    version: 1,
    size: 100,
    chunkBytes: 10,
    oid: sha256Hex(content),
    lfs: true,
    revision: SHA,
    completed,
  });
  const stub = makeRangeStub(new Map([["model.bin", content]]));
  const run = startEngine([file], stub.fetchImpl);
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.deepEqual(readFileSync(file.finalPath), content);
  const requested = new Set(stub.requests.map((request) => request.range));
  assert.equal(stub.requests.length, 7);
  for (const index of completed) {
    assert.equal(requested.has(`bytes=${index * 10}-${index * 10 + 9}`), false);
  }
});

test("a legacy append part is adopted as whole completed chunks", async () => {
  const content = randomBytes(100);
  const file = plannedFile("model.bin", content);
  writeFileSync(file.partPath, content.subarray(0, 25));
  const stub = makeRangeStub(new Map([["model.bin", content]]));
  const run = startEngine([file], stub.fetchImpl);
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.deepEqual(readFileSync(file.finalPath), content);
  const requested = new Set(stub.requests.map((request) => request.range));
  assert.equal(requested.has("bytes=0-9"), false);
  assert.equal(requested.has("bytes=10-19"), false);
  assert.ok(requested.has("bytes=20-29"));
  assert.equal(stub.requests.length, 8);
});

test("a server that ignores bounded ranges falls back to a single stream", async () => {
  const content = randomBytes(100);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    force200: true,
  });
  const run = startEngine([file], stub.fetchImpl);
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.equal(run.statuses.get("model.bin"), "succeeded");
  assert.deepEqual(readFileSync(file.finalPath), content);
  assert.equal(existsSync(hfChunkSidecarPath(file.finalPath)), false);
});

test("transient chunk errors retry with backoff and succeed", async () => {
  const content = randomBytes(30);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    failuresByRange: new Map([["bytes=10-19", 2]]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.deepEqual(readFileSync(file.finalPath), content);
  assert.equal(run.sleeps.length, 2);
});

test("a mid-stream disconnect is classified and the chunk resumes from the flushed offset", async () => {
  const content = randomBytes(30);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    terminateAfter: new Map([["bytes=10-19", 4]]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.equal(run.statuses.get("model.bin"), "succeeded");
  assert.deepEqual(readFileSync(file.finalPath), content);
  const ranges = stub.requests.map((request) => request.range);
  assert.ok(ranges.includes("bytes=14-19"));
  assert.equal(run.sleeps.length, 1);
});

test("repeated disconnects with progress never exhaust the retry limit", async () => {
  const content = randomBytes(20);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    terminateAfter: new Map([
      ["bytes=10-19", 2],
      ["bytes=12-19", 2],
      ["bytes=14-19", 2],
      ["bytes=16-19", 2],
      ["bytes=18-19", 1],
    ]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.deepEqual(readFileSync(file.finalPath), content);
  assert.equal(run.sleeps.length, 5);
});

test("disconnects without progress still exhaust the retry limit", async () => {
  const content = randomBytes(30);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    terminateAfter: new Map([["bytes=10-19", 0]]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.equal(result.failedCount, 1);
  assert.equal(run.statuses.get("model.bin"), "failed");
  assert.equal(run.sleeps.length, 4);
});

test("a single-stream disconnect resumes from the flushed part bytes", async () => {
  const content = randomBytes(8);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    terminateAfter: new Map([["whole", 4]]),
  });
  const run = startEngine([file], stub.fetchImpl);
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.equal(run.statuses.get("model.bin"), "succeeded");
  assert.deepEqual(readFileSync(file.finalPath), content);
  assert.deepEqual(
    stub.requests.map((request) => request.range),
    [null, "bytes=4-"],
  );
});

test("a chunk that keeps failing exhausts retries and fails the file, keeping the part", async () => {
  const content = randomBytes(30);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    failuresByRange: new Map([["bytes=10-19", 99]]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.equal(result.failedCount, 1);
  assert.equal(run.statuses.get("model.bin"), "failed");
  assert.equal(existsSync(file.partPath), true);
  assert.equal(existsSync(hfChunkSidecarPath(file.finalPath)), true);
});

test("an unauthorized chunk fails the job fatally", async () => {
  const content = randomBytes(30);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    failuresByRange: new Map([
      ["bytes=0-9", 99],
      ["bytes=10-19", 99],
      ["bytes=20-29", 99],
    ]),
    failStatus: 401,
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.notEqual(result.fatalError, null);
  assert.equal(run.statuses.get("model.bin"), "failed");
});

test("a corrupted chunk fails the post-pass hash and removes the part", async () => {
  const content = randomBytes(50);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    corruptRanges: new Set(["bytes=20-29"]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  const result = await run.result;
  assert.equal(result.failedCount, 1);
  assert.equal(run.statuses.get("model.bin"), "failed");
  assert.equal(existsSync(file.finalPath), false);
  assert.equal(existsSync(file.partPath), false);
  assert.equal(existsSync(hfChunkSidecarPath(file.finalPath)), false);
});

test("canceling a chunked file keeps the part and sidecar for resume", async () => {
  const content = randomBytes(50);
  const file = plannedFile("model.bin", content);
  const stub = makeRangeStub(new Map([["model.bin", content]]), {
    gatedRanges: new Set(["bytes=40-49"]),
  });
  const run = startEngine([file], stub.fetchImpl, { connections: 2 });
  await waitFor(
    () => (run.bytes.get("model.bin") ?? 0) >= 40,
    "leading chunks to finish",
  );
  run.fileAborts.get("model.bin")?.();
  const result = await run.result;
  assert.deepEqual(result, { failedCount: 0, fatalError: null });
  assert.equal(run.statuses.get("model.bin"), "canceled");
  assert.equal(existsSync(file.partPath), true);
  assert.equal(statSync(file.partPath).size, 50);
  assert.equal(partialBytesFor(file.finalPath), 40);
});
