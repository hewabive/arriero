import assert from "node:assert/strict";
import test from "node:test";

import { vllmLogParser } from "./vllm.js";

test("vllm parser recognizes weight loading and readiness", () => {
  const loading = vllmLogParser.parse({
    lines: ["(EngineCore pid=2) Loading model weights: 42%"],
    cudaDevicesDisabled: false,
  });
  assert.equal(loading.loadProgress.stage, "tensors");
  assert.equal(loading.loadProgress.percent, 42);

  const ready = vllmLogParser.parse({
    lines: ["(APIServer pid=1) INFO: Application startup complete."],
    cudaDevicesDisabled: false,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.loadProgress.stage, "ready");
});

test("vllm parser ignores warning words inside INFO configuration", () => {
  const result = vllmLogParser.parse({
    lines: [
      "(EngineCore pid=2) INFO config: jit_monitor_mode='warn'",
      "(EngineCore pid=2) INFO Kernel JIT monitor will use mode=warn.",
      "(APIServer pid=1) WARNING generation config changed defaults",
    ],
    cudaDevicesDisabled: false,
  });
  assert.deepEqual(result.warnings, [
    "(APIServer pid=1) WARNING generation config changed defaults",
  ]);
});

test("vllm parser treats the default runner limitation as a capability notice", () => {
  const line =
    "(APIServer pid=1) WARNING Model Runner V2 does not yet support the thinking_token_budget request parameter.";
  const result = vllmLogParser.parse({
    lines: [line],
    cudaDevicesDisabled: false,
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notices, [line]);
});

test("vllm parser reads explicit model fields but not the models access log", () => {
  const result = vllmLogParser.parse({
    lines: [
      "(APIServer pid=1) INFO model   /models/Qwen3-4B",
      '(APIServer pid=1) INFO: 127.0.0.1 - "GET /v1/models HTTP/1.1" 200 OK',
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(result.modelPath, "/models/Qwen3-4B");
});

test("vllm parser reads served model and context from startup logs", () => {
  const result = vllmLogParser.parse({
    lines: [
      "(APIServer pid=1) INFO non-default args: {'max_model_len': 4096, 'served_model_name': ['qwen3-0.6b-vllm']}",
      "(EngineCore pid=2) INFO Initializing a V1 LLM engine with config: max_seq_len=4096, served_model_name=qwen3-0.6b-vllm",
    ],
    cudaDevicesDisabled: false,
  });

  assert.equal(result.modelAlias, "qwen3-0.6b-vllm");
  assert.equal(result.contextSize, 4096);
});

test("vllm parser advances beyond completed weight loading", () => {
  const compiling = vllmLogParser.parse({
    lines: [
      "(EngineCore pid=2) Loading safetensors checkpoint shards: 100%",
      "(EngineCore pid=2) INFO torch.compile took 74.92 s in total",
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(compiling.loadProgress.stage, "warmup");
  assert.equal(compiling.loadProgress.percent, 90);

  const capturing = vllmLogParser.parse({
    lines: [
      "(EngineCore pid=2) Loading safetensors checkpoint shards: 100%",
      "(EngineCore pid=2) INFO Available KV cache memory: 6.32 GiB",
      "(EngineCore pid=2) Capturing CUDA graphs (FULL): 50%",
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(capturing.loadProgress.stage, "warmup");
  assert.equal(capturing.loadProgress.percent, 95);
});

test("vllm parser does not treat periodic KV metrics as startup notices", () => {
  const metric =
    "(APIServer pid=1) INFO Running: 0 reqs, GPU KV cache usage: 0.0%";
  const startup = "(EngineCore pid=2) INFO Available KV cache memory: 6.32 GiB";
  const result = vllmLogParser.parse({
    lines: [startup, metric],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(result.notices, [startup]);
});

test("vllm parser keeps real error levels", () => {
  const line = "(EngineCore pid=2) ERROR EngineCore failed to start.";
  const result = vllmLogParser.parse({
    lines: [line],
    cudaDevicesDisabled: false,
  });
  assert.deepEqual(result.errors, [line]);
  assert.equal(result.loadProgress.stage, "error");
});

test("vllm parser exposes the terminal Python exception", () => {
  const traceback = [
    "(APIServer pid=1) Traceback (most recent call last):",
    '(APIServer pid=1)   File "/env/bin/vllm", line 12, in <module>',
    "(APIServer pid=1) huggingface_hub.errors.HFValidationError: invalid repo id",
    "(APIServer pid=1) OSError: Local model path does not exist",
  ];
  const result = vllmLogParser.parse({
    lines: traceback,
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(result.errors, [traceback[0], traceback[2], traceback[3]]);
});
