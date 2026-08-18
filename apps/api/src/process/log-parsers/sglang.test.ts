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
      "Performance config: https://example.test/not-the-listener",
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
    parsed.notices.filter((line) => /DeepSeek-V4|deepseek_v4/.test(line))
      .length,
    3,
  );
  assert.equal(parsed.ready, true);
});

test("SGLang parser skips the wrapped libtorchcodec ignore traceback", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[2026-08-18 23:03:21] Ignore import error when loading sglang.srt.multimodal.processors.mimo_audio: Could not load libtorchcodec. Likely causes:",
      "        The following exceptions were raised as we tried to load libtorchcodec:",
      "[start of libtorchcodec loading traceback]",
      "FFmpeg version 8:",
      "Traceback (most recent call last):",
      '  File "/env/lib/python3.12/site-packages/torch/_ops.py", line 1503, in load_library',
      "OSError: libavutil.so.56: cannot open shared object file: No such file or directory",
      "[end of libtorchcodec loading traceback].",
      "[2026-08-18 23:03:29] Load weight begin. avail mem=21.63 GB",
    ],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(parsed.errors, []);
  assert.notEqual(parsed.loadProgress.stage, "error");
});

test("SGLang parser treats a truncated ignored block head as ignored", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "Traceback (most recent call last):",
      "OSError: libavutil.so.56: cannot open shared object file: No such file or directory",
      "[end of libtorchcodec loading traceback].",
      "[2026-08-18 23:03:29] Load weight begin. avail mem=21.63 GB",
    ],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(parsed.errors, []);
  assert.notEqual(parsed.loadProgress.stage, "error");
});

test("SGLang parser still reports tracebacks after an ignored block closes", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[start of libtorchcodec loading traceback]",
      "Traceback (most recent call last):",
      "[end of libtorchcodec loading traceback].",
      "Traceback (most recent call last):",
      "RuntimeError: CUDA out of memory",
    ],
    cudaDevicesDisabled: false,
  });

  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.loadProgress.stage, "error");
});

test("SGLang parser never classifies request payload text", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[2026-08-12 10:41:01] Receive: obj=GenerateReqInput(text='Explain this Traceback (most recent call last): RuntimeError: error warning failed out of memory', sampling_params={...})",
      "[2026-08-12 10:41:02] Receive OpenAI: obj=ChatCompletionRequest(messages=[{'content': 'why did my exception handler fail with a fatal OOM?'}])",
      "[2026-08-12 10:41:05] Finish: obj=GenerateReqInput(...), out={'text': ' ERROR: the failure is a warning sign', 'meta_info': {...}}",
    ],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.notEqual(parsed.loadProgress.stage, "error");
});

test("SGLang parser keeps benign error-shaped notices out of errors", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[2026-08-12 10:40:59 TP0] The following error message 'operation scheduled before its operands' can be ignored.",
      'INFO:     127.0.0.1:52999 - "GET /health HTTP/1.1" 200 OK',
    ],
    cudaDevicesDisabled: false,
  });

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
});

test("SGLang parser reports scheduler exceptions and prefixed tracebacks", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[2026-08-12 10:41:07 TP0] Scheduler hit an exception: Traceback (most recent call last):",
      '  File "/env/lib/python3.12/site-packages/sglang/srt/managers/scheduler.py", line 5045, in run_scheduler_process',
      "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.50 GiB",
    ],
    cudaDevicesDisabled: false,
  });

  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.loadProgress.stage, "error");
  assert.match(parsed.loadProgress.message, /OutOfMemoryError/);
});

test("SGLang parser reports anchored warning shapes only", () => {
  const parsed = sglangLogParser.parse({
    lines: [
      "[2026-08-12 10:40:58] Warning: The model does not declare a chat template.",
      "/env/lib/python3.12/site-packages/torch/cuda/__init__.py:123: UserWarning: CUDA initialization skipped",
      "[2026-08-12 10:40:59] Set the warning threshold for decode batches.",
    ],
    cudaDevicesDisabled: false,
  });

  assert.equal(parsed.warnings.length, 2);
  assert.deepEqual(parsed.errors, []);
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
