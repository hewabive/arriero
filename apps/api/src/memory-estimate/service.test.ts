import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auxiliaryGgufPaths, estimateMemory } from "./service.js";
import {
  RESOURCES_FILE,
  resetResourcePoolsCache,
} from "../resources/repository.js";

function u32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function ggufString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function kvU32(key: string, value: number) {
  return Buffer.concat([ggufString(key), u32(4), u32(value)]);
}

function kvString(key: string, value: string) {
  return Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
}

function kvStringArray(key: string, count: number) {
  const elements = Array.from({ length: count }, () => ggufString("t"));
  return Buffer.concat([
    ggufString(key),
    u32(9),
    u32(8),
    u64(count),
    ...elements,
  ]);
}

function f16Tensor(name: string, dims: number[]) {
  return Buffer.concat([
    ggufString(name),
    u32(dims.length),
    ...dims.map((dim) => u64(dim)),
    u32(1),
    u64(0),
  ]);
}

function writeSyntheticModel(path: string) {
  const kv = [
    kvString("general.architecture", "llama"),
    kvU32("llama.block_count", 2),
    kvU32("llama.embedding_length", 8),
    kvU32("llama.attention.head_count", 4),
    kvU32("llama.attention.head_count_kv", 2),
    kvU32("llama.context_length", 1024),
    kvStringArray("tokenizer.ggml.tokens", 100),
  ];
  const tensors = [
    f16Tensor("token_embd.weight", [8, 100]),
    f16Tensor("output.weight", [8, 100]),
    f16Tensor("blk.0.attn_k.weight", [8, 4]),
    f16Tensor("blk.0.attn_v.weight", [8, 4]),
    f16Tensor("blk.0.ffn_down.weight", [16, 8]),
    f16Tensor("blk.1.attn_k.weight", [8, 4]),
    f16Tensor("blk.1.attn_v.weight", [8, 4]),
    f16Tensor("blk.1.ffn_down.weight", [16, 8]),
  ];
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from("GGUF", "utf8"),
      u32(3),
      u64(tensors.length),
      u64(kv.length),
      ...kv,
      ...tensors,
    ]),
  );
}

function writeGpuPools() {
  const at = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    RESOURCES_FILE,
    `${JSON.stringify([
      {
        id: "gpu0",
        name: "GPU 0",
        kind: "gpu",
        capacityBytes: 10_000_000,
        reservedBytes: 0,
        deviceRef: "0",
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "gpu1",
        name: "GPU 1",
        kind: "gpu",
        capacityBytes: 10_000_000,
        reservedBytes: 0,
        deviceRef: "1",
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "host",
        name: "Host",
        kind: "host",
        capacityBytes: 10_000_000,
        reservedBytes: 0,
        deviceRef: null,
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
    ])}\n`,
  );
  resetResourcePoolsCache();
}

test("auxiliaryGgufPaths expands repeated, CSV, and scaled arguments", () => {
  assert.deepEqual(
    auxiliaryGgufPaths({
      "--lora": ["/a.gguf,/b.gguf", '"/c,quoted.gguf"'],
      "--lora-scaled": "/d.gguf:0.5,/e.gguf:-1",
      "--control-vector": "/v1.gguf,/v2.gguf",
      "--control-vector-scaled": ["/v3.gguf:0.25"],
    }),
    {
      loraPaths: ["/a.gguf", "/b.gguf", "/c,quoted.gguf", "/d.gguf", "/e.gguf"],
      controlVectorPaths: ["/v1.gguf", "/v2.gguf", "/v3.gguf"],
    },
  );
});

test("vllm estimator reserves utilization on each tensor-parallel GPU", () => {
  const at = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    RESOURCES_FILE,
    `${JSON.stringify([
      {
        id: "gpu0",
        name: "GPU 0",
        kind: "gpu",
        capacityBytes: 10_000,
        reservedBytes: 0,
        deviceRef: "0",
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "gpu1",
        name: "GPU 1",
        kind: "gpu",
        capacityBytes: 20_000,
        reservedBytes: 0,
        deviceRef: "1",
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "host",
        name: "Host",
        kind: "host",
        capacityBytes: 100_000,
        reservedBytes: 0,
        deviceRef: null,
        autoCapacity: false,
        createdAt: at,
        updatedAt: at,
      },
    ])}\n`,
  );
  resetResourcePoolsCache();
  const result = estimateMemory({
    kind: "vllm",
    args: {
      "--tensor-parallel-size": 2,
      "--gpu-memory-utilization": 0.8,
    },
    positionalArgs: ["Qwen/Qwen3-8B"],
    env: { CUDA_VISIBLE_DEVICES: "1,0" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.estimate.draws, [
      { poolId: "gpu1", bytes: 16_000 },
      { poolId: "gpu0", bytes: 8_000 },
    ]);
    assert.equal(result.modelPath, "Qwen/Qwen3-8B");
  }
  rmSync(RESOURCES_FILE, { force: true });
  resetResourcePoolsCache();
});

test("vllm estimator refuses a version-dependent implicit utilization", () => {
  const result = estimateMemory({
    kind: "vllm",
    positionalArgs: ["Qwen/Qwen3-8B"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Set --gpu-memory-utilization explicitly/);
  }
});

test("estimateMemory produces a breakdown for a local model", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    const result = estimateMemory({ args: { "--model": path } });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.modelPath, path);
    assert.equal(result.estimate.weightsBytesTotal, 3968);
    assert.equal(result.estimate.kvBytesTotal, 2 * (8 + 8) * 1024);
    assert.equal(
      result.estimate.computeBytesTotal,
      100 * 512 * 4 + 2 * 8 * 512 * 4,
    );
    assert.equal(result.estimate.confidence, "high");
    assert.ok(result.estimate.draws.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory fails RPC placement confidence closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-rpc-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    const result = estimateMemory({
      args: { "--model": modelPath },
      rpcWorkers: [{ nodeId: null, instanceName: "worker" }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.estimate.confidence, "low");
    assert.match(result.estimate.warnings.join("\n"), /RPC devices/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory loads LoRA tables and accounts for a control vector", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-aux-"));
  const modelPath = join(dir, "model.gguf");
  const loraPath = join(dir, "adapter.gguf");
  const controlPath = join(dir, "direction.gguf");
  try {
    writeSyntheticModel(modelPath);
    writeSyntheticModel(loraPath);
    writeFileSync(controlPath, "fixture existence is sufficient");
    const result = estimateMemory({
      args: {
        "--model": modelPath,
        "--lora-scaled": `${loraPath}:0.5`,
        "--control-vector": controlPath,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.estimate.loraBytesTotal, 3968);
    assert.equal(result.estimate.controlVectorBytesTotal, 8 * 4);
    assert.match(result.estimate.warnings.join("\n"), /1 LoRA adapter/);
    assert.match(result.estimate.warnings.join("\n"), /Control vector/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory rejects a missing auxiliary GGUF", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-aux-missing-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    const result = estimateMemory({
      args: {
        "--model": modelPath,
        "--lora": join(dir, "missing.gguf"),
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Auxiliary GGUF file not found/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GGUF estimate respects visible and disabled GPU devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-gpu-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    writeGpuPools();
    const visible = estimateMemory({
      args: { "--model": path },
      env: { CUDA_VISIBLE_DEVICES: "1" },
    });
    assert.equal(visible.ok, true);
    if (visible.ok) {
      assert.ok(visible.estimate.pools.some((pool) => pool.poolId === "gpu1"));
      assert.ok(!visible.estimate.pools.some((pool) => pool.poolId === "gpu0"));
      assert.equal(visible.estimate.context.nGpuLayers, 3);
    }

    const reordered = estimateMemory({
      args: { "--model": path, "--n-gpu-layers": 99 },
      env: { CUDA_VISIBLE_DEVICES: "1,0" },
    });
    assert.equal(reordered.ok, true);
    if (reordered.ok) {
      assert.equal(
        reordered.estimate.pools.find((pool) => pool.poolId === "gpu1")
          ?.weightsBytes,
        2 * (64 + 64 + 256),
      );
      assert.equal(
        reordered.estimate.pools.find((pool) => pool.poolId === "gpu0")
          ?.weightsBytes,
        1600,
      );
    }

    const explicitLogical = estimateMemory({
      args: {
        "--model": path,
        "--n-gpu-layers": 99,
        "--device": "CUDA0",
      },
      env: { CUDA_VISIBLE_DEVICES: "1,0" },
    });
    assert.equal(explicitLogical.ok, true);
    if (explicitLogical.ok) {
      assert.ok(
        explicitLogical.estimate.pools.some((pool) => pool.poolId === "gpu1"),
      );
      assert.ok(
        !explicitLogical.estimate.pools.some((pool) => pool.poolId === "gpu0"),
      );
    }

    const disabled = estimateMemory({
      args: { "--model": path, "--device": "none" },
    });
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.ok(disabled.estimate.pools.every((pool) => pool.kind === "host"));
      assert.equal(disabled.estimate.context.nGpuLayers, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(RESOURCES_FILE, { force: true });
    resetResourcePoolsCache();
  }
});

test("estimateMemory reports a missing model file", () => {
  const result = estimateMemory({ args: { "--model": "/no/such/model.gguf" } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Model file not found/);
  }
});

test("estimateMemory rejects router presets", () => {
  const result = estimateMemory({ args: { "--models-preset": "router.ini" } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Router/);
  }
});

test("estimateMemory rejects remote models", () => {
  const result = estimateMemory({ args: { "--hf-repo": "org/model:Q4_K_M" } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Remote/);
  }
});

test("estimateMemory reports an unknown instance", () => {
  const result = estimateMemory({ instanceId: "does-not-exist" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /instance not found/);
  }
});
