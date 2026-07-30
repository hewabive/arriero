import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createStaleWhileRevalidate,
  extractRouterChildPorts,
  isManagedDescendant,
  parseProcStatusRss,
  parseProcStatusSwap,
  parsePsOutput,
} from "./runtime-memory.js";
import { managedSignalPid } from "./supervisor.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("parseProcStatusRss splits anonymous and file-backed resident memory", () => {
  const usage = parseProcStatusRss(`
    Name:   llama-server
    VmRSS:     12288 kB
    RssAnon:    2048 kB
    RssFile:    8192 kB
    RssShmem:   2048 kB
  `);

  assert.deepEqual(usage, {
    anonBytes: (2048 + 2048) * 1024,
    fileBytes: 8192 * 1024,
  });
});

test("parseProcStatusRss returns null without resident fields", () => {
  assert.equal(parseProcStatusRss("Name: llama-server\nVmRSS: 100 kB\n"), null);
});

test("parseProcStatusSwap reads swapped-out process memory", () => {
  const contents = `
    Name:   llama-server
    VmRSS:    240648 kB
    VmSwap:  1563368 kB
  `;

  assert.equal(parseProcStatusSwap(contents), 1563368 * 1024);
});

test("parseProcStatusSwap returns null without a VmSwap field", () => {
  assert.equal(
    parseProcStatusSwap("Name: llama-server\nVmRSS: 100 kB\n"),
    null,
  );
});

test("parsePsOutput handles llama-server command lines", () => {
  const processes = parsePsOutput(`
     1000       1 llama-server /opt/llama/bin/llama-server --host 127.0.0.1
     1001    1000 llama-server /opt/llama/bin/llama-server --port 57117
  `);

  assert.deepEqual(processes, [
    {
      pid: 1000,
      ppid: 1,
      command: "llama-server",
      args: "/opt/llama/bin/llama-server --host 127.0.0.1",
    },
    {
      pid: 1001,
      ppid: 1000,
      command: "llama-server",
      args: "/opt/llama/bin/llama-server --port 57117",
    },
  ]);
});

test("descriptor process-tree policy owns all KTransformers descendants", () => {
  const worker = {
    command: "python",
    args: "python -m sglang.srt.managers.scheduler --tp-rank 1",
  };
  assert.equal(isManagedDescendant("ktransformers", worker), true);
  assert.equal(isManagedDescendant("vllm", worker), true);
  assert.equal(isManagedDescendant("rpc-worker", worker), false);
  assert.equal(isManagedDescendant("llama-server", worker), false);
  assert.equal(
    isManagedDescendant("llama-server", {
      command: "llama-server",
      args: "/opt/llama/llama-server --port 8080",
    }),
    true,
  );
});

test("all-descendant engines signal their detached process group", () => {
  assert.equal(managedSignalPid("ktransformers", 1234, "linux"), -1234);
  assert.equal(managedSignalPid("vllm", 1234, "linux"), -1234);
  assert.equal(managedSignalPid("llama-server", 1234, "linux"), 1234);
  assert.equal(managedSignalPid("ktransformers", 1234, "win32"), 1234);
});

test("extractRouterChildPorts finds router child server ports", () => {
  assert.deepEqual(
    extractRouterChildPorts([
      "srv load: spawning server instance with name=Gemma on port 57117",
      "srv load: spawning server instance with name=Qwen on port 57118",
      "srv proxy_request: proxying request to model Gemma on port 57117",
    ]),
    [57117, 57118],
  );
});

test("createStaleWhileRevalidate never blocks the caller on the fetcher", () => {
  const cache = createStaleWhileRevalidate(
    () => new Promise<number[]>(() => {}),
    { ttlMs: 0, empty: [] as number[] },
  );

  assert.deepEqual(cache.get(), []);
});

test("createStaleWhileRevalidate dedupes overlapping refreshes", async () => {
  let calls = 0;
  let resolveCurrent: ((value: number[]) => void) | null = null;
  const cache = createStaleWhileRevalidate(
    () =>
      new Promise<number[]>((resolve) => {
        calls += 1;
        resolveCurrent = resolve;
      }),
    { ttlMs: 0, empty: [] as number[] },
  );

  assert.deepEqual(cache.get(), []);
  assert.deepEqual(cache.get(), []);
  assert.equal(calls, 1);

  resolveCurrent!([1, 2, 3]);
  await tick();
  assert.deepEqual(cache.get(), [1, 2, 3]);
});

test("createStaleWhileRevalidate keeps the last good value when a refresh fails", async () => {
  let rejectCurrent: ((reason: unknown) => void) | null = null;
  let resolveCurrent: ((value: number[]) => void) | null = null;
  const cache = createStaleWhileRevalidate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
      }),
    { ttlMs: 0, empty: [] as number[] },
  );

  cache.get();
  resolveCurrent!([7, 8, 9]);
  await tick();
  assert.deepEqual(cache.get(), [7, 8, 9]);

  rejectCurrent!(new Error("ps killed after timeout"));
  await tick();
  assert.deepEqual(cache.get(), [7, 8, 9]);
});
