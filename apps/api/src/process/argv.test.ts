import assert from "node:assert/strict";
import test from "node:test";

import { engineArgvBuilder } from "./argv.js";
import { buildLaunchSnapshot } from "./launch-snapshot.js";

const flagMap = engineArgvBuilder("flag-map");
const argparseFlags = engineArgvBuilder("argparse-flags");

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

test("argparse-flags expands array values as separate tokens", () => {
  assert.deepEqual(
    argparseFlags(
      {
        "--json": '["a","b"]',
        "--nodes": ["0", "1"],
        "--quiet": false,
        "--trust-remote-code": true,
      },
      ["serve"],
    ),
    [
      "serve",
      "--json",
      '["a","b"]',
      "--nodes",
      "0",
      "1",
      "--trust-remote-code",
    ],
  );
});

test("argparse-flags keeps explicit positionals before sorted flags", () => {
  assert.deepEqual(
    argparseFlags({ "--port": 30001, "--host": "127.0.0.1" }, [
      "serve",
      "model-id",
    ]),
    ["serve", "model-id", "--host", "127.0.0.1", "--port", "30001"],
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
  });
  assert.deepEqual(snapshot.cliArgs, ["serve", "org/model", "--port", "8001"]);
});

test("KTransformers launch snapshot compiles typed model configuration", () => {
  const snapshot = buildLaunchSnapshot({
    name: "kt-test",
    kind: "ktransformers",
    binaryPath: "/tmp/env/bin/sglang",
    binaryPathRefId: "bin",
    args: { "--kt-numa-nodes": ["0", "1"], "--port": 30001 },
    env: {},
    memory: [],
    rpcWorkers: [],
    engineConfig: {
      type: "ktransformers",
      model: "deepseek-ai/DeepSeek-V3",
      cpuWeights: "/models/deepseek-v3-kt",
      method: "AMXINT4",
      servedModelName: "deepseek-v3",
    },
    scheduling: { evictionPolicy: "idle-only" },
    status: "stopped",
    pid: null,
  });
  assert.equal(snapshot.binaryPath, "/tmp/env/bin/python");
  assert.deepEqual(snapshot.cliArgs, [
    "-m",
    "sglang.launch_server",
    "--kt-method",
    "AMXINT4",
    "--kt-numa-nodes",
    "0",
    "1",
    "--kt-weight-path",
    "/models/deepseek-v3-kt",
    "--model-path",
    "deepseek-ai/DeepSeek-V3",
    "--port",
    "30001",
    "--served-model-name",
    "deepseek-v3",
  ]);
});
