import assert from "node:assert/strict";
import test from "node:test";

import { engineArgvBuilder } from "./argv.js";
import { buildLaunchSnapshot } from "./launch-snapshot.js";

const flagMap = engineArgvBuilder("flag-map");

test("flag-map argv serializes array values as one comma-separated argument", () => {
  assert.deepEqual(flagMap({ "--device": ["CUDA0", "CUDA1"] }, []), [
    "--device",
    "CUDA0,CUDA1",
  ]);
});

test("flag-map argv skips empty array values", () => {
  assert.deepEqual(flagMap({ "--tags": [] }, []), []);
});

test("flag-map argv emits positional args before sorted flags", () => {
  assert.deepEqual(
    flagMap({ "--port": 8080, "--alpha": true }, ["serve", "model-id"]),
    ["serve", "model-id", "--alpha", "--port", "8080"],
  );
});

test("flag-map argv without positionals matches the legacy flag-only shape", () => {
  assert.deepEqual(
    flagMap({ "--model": "/models/a.gguf", "--flash-attn": true }, []),
    ["--flash-attn", "--model", "/models/a.gguf"],
  );
});

test("vllm launch snapshot inserts serve before the model positional", () => {
  const snapshot = buildLaunchSnapshot({
    name: "vllm-test",
    kind: "vllm",
    binaryPath: "/tmp/env/bin/vllm",
    binaryPathRefId: "bin",
    args: { "--port": 8001 },
    positionalArgs: ["org/model"],
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "stopped",
    pid: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(snapshot.cliArgs, ["serve", "org/model", "--port", "8001"]);
});
