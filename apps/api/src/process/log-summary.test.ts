import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeState } from "@arriero/core";

import { summarizeInstanceLog } from "./log-summary.js";

function runtime(logPath: string): RuntimeState {
  return {
    instanceId: "test-instance",
    pid: 1234,
    status: "running",
    startedAt: "2026-05-26T00:00:00.000Z",
    stoppedAt: null,
    exitCode: null,
    logPath,
    rawLogPath: null,
  };
}

test("summarizeInstanceLog ignores /slots request IPs when parsing slot count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "main: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true",
        "srv    load_model: loading model '/models/gemma-4-E2B-it-Q4_K_M.gguf'",
        "llama_model_loader: - kv  52: quantize.imatrix.file str = gemma-4-E2B-it-GGUF/imatrix_unsloth.gguf",
        "srv    load_model: initializing slots, n_slots = 4",
        "main: server is listening on http://82.38.68.56:5174",
        "srv  log_server_r: done request: GET /slots 82.38.68.56 200",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.slots, 4);
    assert.equal(summary.modelPath, "/models/gemma-4-E2B-it-Q4_K_M.gguf");
    assert.equal(summary.listeningUrl, "http://82.38.68.56:5174");
    assert.equal(summary.loadProgress.stage, "ready");
    assert.equal(summary.loadProgress.percent, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog reports starting when the listener is up but no model load has begun", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "main: HTTP server is listening, hostname: 127.0.0.1, port: 8080",
        "main: server is listening on http://127.0.0.1:8080",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.loadProgress.stage, "starting");
    assert.equal(summary.loadProgress.percent, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog estimates tensor loading progress from loader dots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "main: loading model",
        "srv    load_model: loading model '/models/big.gguf'",
        "llama_model_loader: loaded meta data with 40 key-value pairs and 500 tensors from /models/big.gguf",
        "load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)",
        "load_tensors:   CPU_Mapped model buffer size = 12345.67 MiB",
        "................................................",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.loadProgress.stage, "tensors");
    assert.equal(summary.loadProgress.estimated, true);
    assert.ok(summary.loadProgress.percent !== null);
    assert.ok(summary.loadProgress.percent > 40);
    assert.ok(summary.loadProgress.percent < 90);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog reports staged loading when tensor dots are absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "srv    load_model: loading model '/models/big.gguf'",
        "common_init_result: fitting params to device memory ...",
        "common_params_fit_impl: projected to use 48000 MiB of host memory vs. 64000 MiB of total host memory",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.loadProgress.stage, "metadata");
    assert.equal(summary.loadProgress.percent, 25);
    assert.match(summary.loadProgress.message, /exact tensor progress/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog handles load_tensors without progress dots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "srv    load_model: loading model '/models/big.gguf'",
        "load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.loadProgress.stage, "tensors");
    assert.equal(summary.loadProgress.percent, 40);
    assert.match(summary.loadProgress.message, /no tensor progress markers/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog parses per-device memory layout from buffer lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "llama_model_load: offloaded 29/29 layers to GPU",
        "llama_model_load:        CUDA0 model buffer size =  3580.25 MiB",
        "llama_model_load:   CPU_Mapped model buffer size =   512.50 MiB",
        "llama_kv_cache_init:      CUDA0 KV buffer size =  2048.00 MiB",
        "llama_init_from_model:    CUDA0  output buffer size =     0.50 MiB",
        "llama_context:            CUDA0 compute buffer size =   256.00 MiB",
        "llama_context:              CPU compute buffer size =    12.00 MiB",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });
    const cuda = summary.memoryLayout.entries.find(
      (entry) => entry.label === "CUDA0",
    );
    const cpuMapped = summary.memoryLayout.entries.find(
      (entry) => entry.label === "CPU_Mapped",
    );
    const cpu = summary.memoryLayout.entries.find(
      (entry) => entry.label === "CPU",
    );

    assert.equal(cuda?.kind, "device");
    assert.equal(cuda?.modelBytes, Math.round(3580.25 * 1024 * 1024));
    assert.equal(cuda?.contextBytes, 2048 * 1024 * 1024);
    assert.equal(cuda?.computeBytes, 256 * 1024 * 1024);
    assert.equal(cuda?.outputBytes, Math.round(0.5 * 1024 * 1024));
    assert.equal(cpuMapped?.kind, "host");
    assert.equal(cpuMapped?.modelBytes, Math.round(512.5 * 1024 * 1024));
    assert.equal(cpu?.kind, "host");
    assert.equal(cpu?.computeBytes, 12 * 1024 * 1024);
    assert.equal(summary.memoryLayout.deviceBytes, cuda?.totalBytes);
    assert.equal(
      summary.memoryLayout.hostBytes,
      (cpuMapped?.totalBytes ?? 0) + (cpu?.totalBytes ?? 0),
    );
    assert.equal(summary.memoryLayout.projectedHostBytes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog parses projected host memory when exact buffers are absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "common_params_fit_impl: projected to use 940 MiB of host memory vs. 7917 MiB of total host memory",
        "srv    load_model: loading model '/models/small.gguf'",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.memoryLayout.totalBytes, 0);
    assert.equal(summary.memoryLayout.projectedHostBytes, 940 * 1024 * 1024);
    assert.equal(
      summary.memoryLayout.projectedHostTotalBytes,
      7917 * 1024 * 1024,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog reports warmup as late loading stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "srv    load_model: loading model '/models/big.gguf'",
        "load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)",
        "............................................................................",
        "srv    load_model: warming up the model with an empty run",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.loadProgress.stage, "warmup");
    assert.equal(summary.loadProgress.percent, 95);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores transient router connection errors before child readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.17.179.974 I srv          load: spawning server instance with name=Gemma on port 57117",
        "0.17.466.965 I srv  proxy_reques: proxying request to model Gemma on port 57117",
        "0.17.467.473 E srv    operator(): http client error: Could not establish connection",
        "0.17.467.526 E srv    operator(): http client error: Could not establish connection",
        "[57117] 0.12.314.080 I srv  llama_server: model loaded",
        "[57117] 0.12.314.086 I srv  llama_server: server is listening on http://127.0.0.1:57117",
        "[57117] cmd_child_to_router:ready",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.ready, true);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.loadProgress.stage, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog keeps router connection errors after readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "[57117] 0.12.314.080 I srv  llama_server: model loaded",
        "[57117] cmd_child_to_router:ready",
        "1.17.467.473 E srv    operator(): http client error: Could not establish connection",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores per-request context size overflow errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.01.273.782 I srv  llama_server: model loaded",
        "0.01.273.793 I srv  llama_server: server is listening on http://127.0.0.1:9002",
        "0.39.544.530 E srv    send_error: task id = 4, error: request (23182 tokens) exceeds the available context size (16384 tokens), try increasing it",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.ready, true);
    assert.deepEqual(summary.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores chat requests rejected by an embedding-only context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.01.273.782 I srv  llama_server: model loaded",
        "0.01.273.793 I srv  llama_server: server is listening on http://127.0.0.1:9002",
        "0.39.544.530 E srv    send_error: task id = 5, error: the current context does not logits computation. skipping",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.ready, true);
    assert.deepEqual(summary.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores capability probe rejection exceptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.00.009.237 I srv  llama_server: server is listening on http://127.0.0.1:5181",
        `0.12.754.481 W srv    operator(): got exception: {"error":{"code":400,"message":"'messages' is required","type":"invalid_request_error"}}`,
        `0.12.757.292 W srv    operator(): got exception: {"error":{"code":400,"message":"'input' is required","type":"invalid_request_error"}}`,
        `0.12.757.846 W srv    operator(): got exception: {"error":{"code":500,"message":"'messages' is required","type":"server_error"}}`,
        `0.12.758.536 W srv    operator(): got exception: {"error":{"code":500,"message":"'messages' is required","type":"server_error"}}`,
        `0.12.758.690 W srv    operator(): got exception: {"error":{"code":400,"message":"'messages' is required","type":"invalid_request_error"}}`,
        `0.12.758.901 W srv    operator(): got exception: {"error":{"code":400,"message":"'input' is required","type":"invalid_request_error"}}`,
        `0.12.759.035 W srv    operator(): got exception: {"error":{"code":400,"message":"'messages' is required","type":"invalid_request_error"}}`,
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.deepEqual(summary.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog keeps genuine server_error exceptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.00.009.237 I srv  llama_server: server is listening on http://127.0.0.1:5181",
        `0.40.000.000 W srv    operator(): got exception: {"error":{"code":500,"message":"failed to decode batch","type":"server_error"}}`,
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores the multimodal capability probe failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.00.006.792 E get_hf_plan: no GGUF files found in repository unsloth/Qwen3.5-0.8B-MTP-GGUF",
        "0.00.006.932 W failed to initialize common_params for multimodal capability detection: failed to download model from Hugging Face",
        "0.00.009.237 I srv  llama_server: router server is listening on http://127.0.0.1:5181",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog ignores the CUDA init failure when devices are disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.00.060.896 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected",
        "0.01.273.782 I srv  llama_server: model loaded",
        "0.01.273.793 I srv  llama_server: server is listening on http://127.0.0.1:9002",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
      cudaDevicesDisabled: true,
    });

    assert.deepEqual(summary.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeInstanceLog keeps the CUDA init failure when devices are not disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-log-summary-"));
  const logPath = join(dir, "llama-server.log");
  try {
    writeFileSync(
      logPath,
      [
        "0.00.060.896 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected",
        "0.01.273.782 I srv  llama_server: model loaded",
        "0.01.273.793 I srv  llama_server: server is listening on http://127.0.0.1:9002",
      ].join("\n"),
    );

    const summary = await summarizeInstanceLog({
      kind: "llama-server",
      instanceId: "test-instance",
      runtime: runtime(logPath),
    });

    assert.equal(summary.errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
