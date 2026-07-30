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

test("SGLang parser treats optional DeepSeek-V4 imports as notices", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "DSV4 side-effect import failed: sglang.srt.layers.quantization.mxfp4_deepseek -> DeepSeek-V4-Flash MXFP4 MoE requires flashinfer >= 0.6.9 (found 0.6.3). DSV4 model will register but the affected plugin may not be available.",
      "In import_model_classes: Ignore import error when loading sglang.srt.models.deepseek_v4: No module named 'tilelang'",
      "In import_model_classes: Ignore import error when loading sglang.srt.models.deepseek_v4_nextn: No module named 'tilelang'",
      "Application startup complete.",
    ],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(parsed.errors, []);
  assert.equal(
    parsed.notices.filter((line) =>
      /DeepSeek-V4|deepseek_v4/.test(line),
    ).length,
    3,
  );
  assert.equal(parsed.ready, true);
});

test("SGLang parser still reports non-optional import failures", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "In import_model_classes: import error when loading qwen3_moe: missing kernel",
    ],
    cudaDevicesDisabled: false,
  });

  assert.equal(parsed.errors.length, 1);
});
