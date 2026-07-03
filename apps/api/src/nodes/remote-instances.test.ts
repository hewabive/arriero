import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRemoteInstances } from "./remote-instances.js";

function remoteInstance(overrides: Record<string, unknown> = {}) {
  return {
    name: "remote-a",
    kind: "llama-server",
    binaryPathRefId: "ref",
    binaryPath: "/opt/llama/llama-server",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "running",
    pid: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("parseRemoteInstances keeps valid entries and skips unknown-kind ones", () => {
  const parsed = parseRemoteInstances([
    remoteInstance(),
    remoteInstance({ name: "remote-b", kind: "vllm-server" }),
    remoteInstance({ name: "remote-c", kind: "rpc-worker" }),
  ]);
  assert.deepEqual(
    parsed.map((instance) => instance.name),
    ["remote-a", "remote-c"],
  );
});

test("parseRemoteInstances returns empty for non-array payloads", () => {
  assert.deepEqual(parseRemoteInstances({ data: [] }), []);
  assert.deepEqual(parseRemoteInstances(null), []);
});
