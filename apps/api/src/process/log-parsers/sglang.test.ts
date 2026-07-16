import assert from "node:assert/strict";
import test from "node:test";

import { sglangLogParser } from "./sglang.js";

test("SGLang parser tracks KTransformers weight loading", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "model_path=deepseek-ai/DeepSeek-V3 context_length=32768",
      "Loading checkpoint shards: 2/4",
      "KTransformers kt-kernel loading expert weights",
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(parsed.modelPath, "deepseek-ai/DeepSeek-V3");
  assert.equal(parsed.contextSize, 32768);
  assert.equal(parsed.loadProgress.stage, "tensors");
  assert.ok(parsed.notices.length > 0);
});

test("SGLang log readiness is progress only and captures the listener", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "Application startup complete.",
      "Uvicorn running on http://127.0.0.1:30000 (Press CTRL+C to quit)",
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(parsed.ready, true);
  assert.equal(parsed.listeningUrl, "http://127.0.0.1:30000");
  assert.equal(parsed.loadProgress.stage, "ready");
  assert.match(parsed.loadProgress.message, /HTTP health/);
});

test("SGLang parser surfaces traceback and OOM failures", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "Traceback (most recent call last):",
      "RuntimeError: CUDA out of memory",
    ],
    cudaDevicesDisabled: false,
  });
  assert.equal(parsed.loadProgress.stage, "error");
  assert.equal(parsed.errors.length, 2);
});
