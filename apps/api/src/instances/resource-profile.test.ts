import {
  deriveInstanceResourceProfile,
  type InstanceResourceProfileInput,
} from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

const POOLS: InstanceResourceProfileInput["pools"] = [
  { id: "gpu0", kind: "gpu", deviceRef: "0", name: "RTX 4090 #0" },
  { id: "gpu1", kind: "gpu", deviceRef: "1", name: "RTX 4090 #1" },
  { id: "host", kind: "host", deviceRef: null, name: "Host RAM" },
];

function profile(
  overrides: Partial<InstanceResourceProfileInput>,
): ReturnType<typeof deriveInstanceResourceProfile> {
  return deriveInstanceResourceProfile({
    kind: "llama-server",
    args: {},
    env: {},
    memory: [],
    pools: POOLS,
    model: null,
    gpuLayersDefault: null,
    ...overrides,
  });
}

test("all GPUs visible with full offload places only on GPU", () => {
  const result = profile({
    args: { "--n-gpu-layers": "999" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "gpu");
  assert.equal(result.usesHost, false);
  assert.equal(result.cpuReason, null);
  assert.equal(result.signals.nGpuLayersCoversModel, true);
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu0", "gpu1"],
  );
});

test("CUDA_VISIBLE_DEVICES selects the matching pool, not gpu0", () => {
  const result = profile({
    args: { "--n-gpu-layers": "all" },
    env: { CUDA_VISIBLE_DEVICES: "1" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "gpu");
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu1"],
  );
});

test("cpu-moe on a MoE model keeps the CPU chip even at full offload", () => {
  const result = profile({
    args: { "--n-gpu-layers": "all", "--cpu-moe": true },
    model: { blockCount: 48, expertCount: 128 },
  });
  assert.equal(result.placement, "hybrid");
  assert.equal(result.usesHost, true);
  assert.match(result.cpuReason ?? "", /MoE experts on host/);
});

test("cpu-moe on a dense model does not force the CPU chip", () => {
  const result = profile({
    args: { "--n-gpu-layers": "all", "--cpu-moe": true },
    model: { blockCount: 32, expertCount: 1 },
  });
  assert.equal(result.placement, "gpu");
  assert.equal(result.usesHost, false);
});

test("partial offload is hybrid with a host-layer reason", () => {
  const result = profile({
    args: { "--n-gpu-layers": "10" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "hybrid");
  assert.equal(result.usesHost, true);
  assert.match(result.cpuReason ?? "", /of 33 layers on host/);
});

test("-ngl 0 is CPU-only", () => {
  const result = profile({
    args: { "--n-gpu-layers": "0" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "cpu");
  assert.deepEqual(result.gpuPools, []);
});

test("empty CUDA_VISIBLE_DEVICES disables the GPU regardless of -ngl", () => {
  const result = profile({
    args: { "--n-gpu-layers": "all" },
    env: { CUDA_VISIBLE_DEVICES: "" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "cpu");
  assert.match(result.cpuReason ?? "", /CUDA_VISIBLE_DEVICES/);
});

test("vllm tensor parallelism selects the first visible GPU pools", () => {
  const result = profile({
    kind: "vllm",
    args: { "--tensor-parallel-size": 1 },
    env: { CUDA_VISIBLE_DEVICES: "1,0" },
  });
  assert.equal(result.placement, "gpu");
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu1"],
  );
});

test("vllm --device cpu produces a host profile", () => {
  const result = profile({ kind: "vllm", args: { "--device": "cpu" } });
  assert.equal(result.placement, "cpu");
  assert.equal(result.usesHost, true);
});

test("KTransformers is always hybrid and follows CUDA tensor-parallel order", () => {
  const result = profile({
    kind: "ktransformers",
    args: { "--tensor-parallel-size": 1 },
    env: { CUDA_VISIBLE_DEVICES: "1,0" },
  });
  assert.equal(result.placement, "hybrid");
  assert.equal(result.usesHost, true);
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu1"],
  );
  assert.match(result.cpuReason ?? "", /CPU workers/);
});

test("KTransformers honours the SGLang --tp-size spelling when picking GPUs", () => {
  const result = profile({
    kind: "ktransformers",
    args: { "--tp-size": 2 },
    env: { CUDA_VISIBLE_DEVICES: "1,0" },
  });
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu1", "gpu0"],
  );
});

test("KTransformers reports exact declared hybrid pools", () => {
  const result = profile({
    kind: "ktransformers",
    memory: [
      { poolId: "gpu1", bytes: 1024 },
      { poolId: "host", bytes: 2048 },
    ],
  });
  assert.equal(result.placement, "hybrid");
  assert.equal(result.confidence, "declared");
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu1"],
  );
});

test("declared GPU draws win and report exact pools", () => {
  const result = profile({
    args: {},
    memory: [{ poolId: "gpu0", bytes: 1024 }],
  });
  assert.equal(result.placement, "gpu");
  assert.equal(result.confidence, "declared");
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu0"],
  );
});

test("declared GPU + host draws are hybrid", () => {
  const result = profile({
    memory: [
      { poolId: "gpu0", bytes: 1024 },
      { poolId: "host", bytes: 2048 },
    ],
  });
  assert.equal(result.placement, "hybrid");
  assert.equal(result.usesHost, true);
});

test("tensor-split narrows the GPU set to weighted devices", () => {
  const result = profile({
    args: { "--n-gpu-layers": "all", "--tensor-split": "1,0" },
    model: { blockCount: 32, expertCount: null },
  });
  assert.deepEqual(
    result.gpuPools.map((pool) => pool.poolId),
    ["gpu0"],
  );
  assert.equal(result.signals.source, "tensor-split");
});

test("unknown model with all-offload is GPU, finite offload is conservative hybrid", () => {
  const full = profile({ args: { "--n-gpu-layers": "all" } });
  assert.equal(full.placement, "gpu");
  assert.equal(full.confidence, "args");
  assert.equal(full.signals.nGpuLayersCoversModel, null);

  const finite = profile({ args: { "--n-gpu-layers": "20" } });
  assert.equal(finite.placement, "hybrid");
  assert.match(finite.cpuReason ?? "", /model layers unknown/);
});

test("binary default auto offloads fully when -ngl is absent", () => {
  const result = profile({
    gpuLayersDefault: "auto",
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "gpu");
  assert.equal(result.usesHost, false);
  assert.equal(result.cpuReason, null);
  assert.equal(result.signals.source, "binary-default");
  assert.equal(result.signals.nGpuLayersCoversModel, true);
  assert.equal(result.signals.gpuLayersDefault, "auto");
});

test("explicit -ngl 0 wins over the binary default", () => {
  const result = profile({
    args: { "--n-gpu-layers": "0" },
    gpuLayersDefault: "auto",
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "cpu");
  assert.equal(result.signals.source, "n-gpu-layers");
});

test("binary default 0 keeps the no-offload profile", () => {
  const result = profile({
    gpuLayersDefault: "0",
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "cpu");
  assert.match(result.cpuReason ?? "", /No GPU offload configured/);
  assert.equal(result.signals.source, "none");
});

test("binary default auto without GPU pools stays CPU", () => {
  const result = profile({
    gpuLayersDefault: "auto",
    pools: [{ id: "host", kind: "host", deviceRef: null, name: "Host RAM" }],
    model: { blockCount: 32, expertCount: null },
  });
  assert.equal(result.placement, "cpu");
});

test("rpc-worker derives placement from --device", () => {
  const gpu = profile({
    kind: "rpc-worker",
    args: { "--device": "CUDA1" },
  });
  assert.equal(gpu.placement, "gpu");
  assert.deepEqual(
    gpu.gpuPools.map((pool) => pool.poolId),
    ["gpu1"],
  );

  const cpu = profile({ kind: "rpc-worker", args: { "--device": "CPU" } });
  assert.equal(cpu.placement, "cpu");
});
