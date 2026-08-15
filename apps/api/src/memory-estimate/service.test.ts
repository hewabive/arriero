import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auxiliaryGgufPaths,
  estimateMemory,
  resolveLlamaArgumentEnvironment,
} from "./service.js";
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

test("auxiliaryGgufPaths expands repeated, CSV, and scaled arguments", async () => {
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

test("llama environment arguments are applied before estimation and CLI aliases win", async () => {
  const resolved = resolveLlamaArgumentEnvironment(
    {
      "--ctx-size": 256,
      "--gpu-layers": false,
      "--no-repack": true,
    },
    {
      LLAMA_ARG_CTX_SIZE: "8192",
      LLAMA_ARG_N_GPU_LAYERS: "0",
      LLAMA_ARG_KV_OFFLOAD: "false",
      LLAMA_ARG_NO_KV_UNIFIED: "0",
      LLAMA_ARG_NO_REPACK: "present",
    },
  );

  assert.equal(resolved["--ctx-size"], 256);
  assert.equal(resolved["--gpu-layers"], "0");
  assert.equal(resolved["--kv-offload"], "false");
  assert.equal(resolved["--no-kv-unified"], true);
  assert.equal(resolved["--no-repack"], true);
});

test("vllm estimator reserves utilization on each tensor-parallel GPU", async () => {
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
  const result = await estimateMemory({
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

test("vllm estimator refuses a version-dependent implicit utilization", async () => {
  const result = await estimateMemory({
    kind: "vllm",
    positionalArgs: ["Qwen/Qwen3-8B"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Set --gpu-memory-utilization explicitly/);
  }
});

test("estimateMemory is not applicable to engines without an estimator", async () => {
  for (const kind of ["rpc-worker", "ktransformers"] as const) {
    const result = await estimateMemory({ kind });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.reason,
        `memory estimate is not applicable to ${kind} instances`,
      );
    }
  }
});

test("estimateMemory produces a breakdown for a local model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    const result = await estimateMemory({
      args: { "--model": path, "--fit": "off" },
    });
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

test("estimateMemory resolves memory-affecting LLAMA_ARG environment values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-env-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    writeGpuPools();
    const result = await estimateMemory({
      env: {
        LLAMA_ARG_MODEL: path,
        LLAMA_ARG_CTX_SIZE: "512",
        LLAMA_ARG_DEVICE: "none",
        LLAMA_ARG_FIT: "off",
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.modelPath, path);
    assert.equal(result.estimate.context.nCtx, 512);
    assert.equal(result.estimate.context.nGpuLayers, 0);
    assert.ok(result.estimate.pools.every((pool) => pool.kind === "host"));

    const envDisabledKv = await estimateMemory({
      env: {
        LLAMA_ARG_MODEL: path,
        LLAMA_ARG_CTX_SIZE: "512",
        LLAMA_ARG_DEVICE: "CUDA0",
        LLAMA_ARG_N_GPU_LAYERS: "all",
        LLAMA_ARG_KV_OFFLOAD: "false",
        LLAMA_ARG_FIT: "off",
      },
    });
    assert.equal(envDisabledKv.ok, true);
    if (envDisabledKv.ok) {
      assert.ok(
        (envDisabledKv.estimate.pools.find((pool) => pool.poolId === "host")
          ?.kvBytes ?? 0) > 0,
      );
      assert.equal(
        envDisabledKv.estimate.pools.find((pool) => pool.poolId === "gpu0")
          ?.kvBytes ?? 0,
        0,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(RESOURCES_FILE, { force: true });
    resetResourcePoolsCache();
  }
});

test("estimateMemory fails RPC placement confidence closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-rpc-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    const result = await estimateMemory({
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

test("estimateMemory loads LoRA tables and accounts for a control vector", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-aux-"));
  const modelPath = join(dir, "model.gguf");
  const loraPath = join(dir, "adapter.gguf");
  const controlPath = join(dir, "direction.gguf");
  try {
    writeSyntheticModel(modelPath);
    writeSyntheticModel(loraPath);
    writeFileSync(controlPath, "fixture existence is sufficient");
    const result = await estimateMemory({
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

test("estimateMemory rejects a missing auxiliary GGUF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-aux-missing-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    const result = await estimateMemory({
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

test("estimateMemory rejects missing draft and multimodal GGUFs instead of omitting them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-missing-sidecars-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    for (const [key, label] of [
      ["--mmproj", "Multimodal projector"],
      ["--spec-draft-model", "Speculative draft"],
    ] as const) {
      const result = await estimateMemory({
        args: { "--model": modelPath, [key]: join(dir, "missing.gguf") },
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, new RegExp(label));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory rejects remote sidecars and selectors even beside a local model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-remote-sidecars-"));
  const modelPath = join(dir, "model.gguf");
  try {
    writeSyntheticModel(modelPath);
    const cases = [
      { "--model": modelPath, "--hf-repo": "org/repo" },
      { "--model": modelPath, "--docker-repo": "model:q4" },
      { "--model": modelPath, "--mmproj-url": "https://example/mmproj.gguf" },
      { "--model": modelPath, "--spec-draft-hf": "org/draft" },
    ];
    for (const args of cases) {
      assert.equal((await estimateMemory({ args })).ok, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GGUF estimate respects visible and disabled GPU devices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-gpu-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    writeGpuPools();
    const visible = await estimateMemory({
      args: { "--model": path },
      env: { CUDA_VISIBLE_DEVICES: "1" },
    });
    assert.equal(visible.ok, true);
    if (visible.ok) {
      assert.ok(visible.estimate.pools.some((pool) => pool.poolId === "gpu1"));
      assert.ok(!visible.estimate.pools.some((pool) => pool.poolId === "gpu0"));
      assert.equal(visible.estimate.context.nGpuLayers, 3);
    }

    const reordered = await estimateMemory({
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

    const explicitLogical = await estimateMemory({
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

    const disabled = await estimateMemory({
      args: { "--model": path, "--device": "none" },
    });
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.ok(disabled.estimate.pools.every((pool) => pool.kind === "host"));
      assert.equal(disabled.estimate.context.nGpuLayers, 0);
    }

    const cpuDevice = await estimateMemory({
      args: { "--model": path, "--device": "CPU" },
    });
    assert.equal(cpuDevice.ok, false);
    if (!cpuDevice.ok) {
      assert.match(cpuDevice.reason, /unsupported --device.*CPU/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(RESOURCES_FILE, { force: true });
    resetResourcePoolsCache();
  }
});

test("GGUF estimate rejects device backends that cannot be mapped to local pools", async () => {
  const result = await estimateMemory({
    args: { "--model": "/not/read.gguf", "--device": "Vulkan0" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /unsupported --device.*Vulkan0/);
  }
});

test("GGUF estimate rejects unavailable CUDA indices and invalid main-gpu", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-device-index-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    writeGpuPools();
    const unavailable = await estimateMemory({
      args: { "--model": path, "--device": "CUDA2" },
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.match(unavailable.reason, /do not map to configured memory pools/);
    }

    const invalidMain = await estimateMemory({
      args: {
        "--model": path,
        "--device": "CUDA0",
        "--split-mode": "none",
        "--main-gpu": 1,
      },
    });
    assert.equal(invalidMain.ok, false);
    if (!invalidMain.ok) {
      assert.match(invalidMain.reason, /outside the selected device list/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(RESOURCES_FILE, { force: true });
    resetResourcePoolsCache();
  }
});

test("estimateMemory reports a missing model file", async () => {
  const result = await estimateMemory({
    args: { "--model": "/no/such/model.gguf" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Model file not found/);
  }
});

test("estimateMemory rejects router presets", async () => {
  const result = await estimateMemory({
    args: { "--models-preset": "router.ini" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Router/);
  }
});

test("estimateMemory rejects built-in presets until their rewritten args are resolved", async () => {
  const result = await estimateMemory({
    args: { "--gpt-oss-20b-default": true },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /presets rewrite/);
  }
});

test("estimateMemory rejects current parser exits and invalid context geometry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-current-args-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    const cases: Array<[Record<string, string | number | boolean>, RegExp]> = [
      [{ "--draft": 4 }, /removed llama\.cpp argument/],
      [{ "--help": true }, /print information and exit/],
      [{ "--parallel": 0 }, /negative auto value/],
      [{ "--parallel": 257 }, /through 256/],
      [{ "--ctx-size": -1 }, /zero or a positive integer/],
      [{ "--batch-size": 0 }, /positive integer/],
      [{ "--ubatch-size": -1 }, /zero or a positive integer/],
      [{ "--kv-offload": "false" }, /flag-style boolean/],
      [
        { "--embedding": true, "--ubatch-size": 0 },
        /embedding\/rerank batch clamp/,
      ],
    ];

    for (const [extraArgs, expected] of cases) {
      const result = await estimateMemory({
        args: { "--model": path, "--fit": "off", ...extraArgs },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory requires local sidecars for separate draft implementations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-estsvc-draft-required-"));
  const path = join(dir, "model.gguf");
  try {
    writeSyntheticModel(path);
    for (const type of [
      "draft-simple",
      "draft-eagle3",
      "draft-dflash",
      "draft-dspark",
    ]) {
      const result = await estimateMemory({
        args: {
          "--model": path,
          "--fit": "off",
          "--spec-type": type,
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /requires an explicit local/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateMemory rejects remote models", async () => {
  const result = await estimateMemory({
    args: { "--hf-repo": "org/model:Q4_K_M" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Remote/);
  }
});

test("estimateMemory reports an unknown instance", async () => {
  const result = await estimateMemory({ instanceId: "does-not-exist" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /instance not found/);
  }
});
