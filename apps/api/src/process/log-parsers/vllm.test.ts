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

test("vllm parser keeps real error levels", () => {
  const line = "(EngineCore pid=2) ERROR EngineCore failed to start.";
  const result = vllmLogParser.parse({
    lines: [line],
    cudaDevicesDisabled: false,
  });
  assert.deepEqual(result.errors, [line]);
  assert.equal(result.loadProgress.stage, "error");
});
