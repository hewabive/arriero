import { strict as assert } from "node:assert";
import test from "node:test";

import {
  estimateInstanceMemory,
  resolveContextParams,
  type GgufTensorInfo,
  type GgufTensorTable,
  type MemoryEstimateHparams,
} from "@arriero/core";

function f16Tensor(name: string, dims: number[]): GgufTensorInfo {
  const elements = dims.reduce((product, dim) => product * dim, 1);
  return { name, typeId: 1, type: "f16", dims, elements, bytes: elements * 2 };
}

function syntheticTable(extra: GgufTensorInfo[] = []): GgufTensorTable {
  const tensors: GgufTensorInfo[] = [
    f16Tensor("token_embd.weight", [8, 100]),
    f16Tensor("output.weight", [8, 100]),
    f16Tensor("blk.0.attn_k.weight", [8, 4]),
    f16Tensor("blk.0.attn_v.weight", [8, 4]),
    f16Tensor("blk.0.ffn_down.weight", [16, 8]),
    f16Tensor("blk.1.attn_k.weight", [8, 4]),
    f16Tensor("blk.1.attn_v.weight", [8, 4]),
    f16Tensor("blk.1.ffn_down.weight", [16, 8]),
    ...extra,
  ];
  return {
    path: "synthetic.gguf",
    tensorCount: tensors.length,
    totalBytes: tensors.reduce((sum, tensor) => sum + tensor.bytes, 0),
    unknownTypeIds: [],
    tensors,
  };
}

const HPARAMS: MemoryEstimateHparams = {
  architecture: "llama",
  blockCount: 2,
  embeddingLength: 8,
  headCount: 4,
  headCountKv: 2,
  attentionKeyLength: null,
  attentionValueLength: null,
  attentionKeyLengthMla: null,
  attentionValueLengthMla: null,
  causalAttention: null,
  contextLength: 1024,
  slidingWindow: null,
  slidingWindowPattern: null,
  sharedKvLayers: null,
  nextnPredictLayers: null,
  shortConvCacheLength: null,
  ssmConvKernel: null,
  ssmGroupCount: null,
  ssmInnerSize: null,
  ssmStateSize: null,
  wkvHeadSize: null,
  tokenShiftCount: null,
  kdaHeadDim: null,
  vocabularySize: 100,
};

const HOST_POOLS = [{ id: "host", kind: "host" as const }];

test("resolveContextParams applies server defaults", () => {
  const ctx = resolveContextParams({}, HPARAMS);
  assert.equal(ctx.nCtx, 1024);
  assert.equal(ctx.nCtxSeq, 1024);
  assert.equal(ctx.nUbatch, 512);
  assert.equal(ctx.nBatch, 1024);
  assert.equal(ctx.nSeqMax, 4);
  assert.equal(ctx.kvUnified, true);
  assert.equal(ctx.swaFull, false);
  assert.equal(ctx.typeK, "f16");
  assert.equal(ctx.offloadKqv, true);
  assert.equal(ctx.nGpuLayers, 0);
});

test("resolveContextParams reads overrides and pads context", () => {
  const ctx = resolveContextParams(
    {
      "--ctx-size": 2000,
      "--ubatch-size": 256,
      "--cache-type-k": "q8_0",
      "--swa-full": true,
      "--no-kv-offload": "on",
      "--n-gpu-layers": 99,
    },
    HPARAMS,
  );
  assert.equal(ctx.nCtx, 2048);
  assert.equal(ctx.nUbatch, 256);
  assert.equal(ctx.typeK, "q8_0");
  assert.equal(ctx.swaFull, true);
  assert.equal(ctx.offloadKqv, false);
  assert.equal(ctx.nGpuLayers, 3);
});

test("an explicit parallel count uses the server's non-unified KV default", () => {
  const explicit = resolveContextParams({ "--parallel": 4 }, HPARAMS);
  assert.equal(explicit.nSeqMax, 4);
  assert.equal(explicit.kvUnified, false);
  assert.equal(explicit.nCtxSeq, 256);

  const forced = resolveContextParams(
    { "--parallel": 4, "--kv-unified": true },
    HPARAMS,
  );
  assert.equal(forced.kvUnified, true);
  assert.equal(forced.nCtxSeq, 1024);

  const disabled = resolveContextParams({ "--no-kv-unified": true }, HPARAMS);
  assert.equal(disabled.kvUnified, false);
});

test("estimateInstanceMemory computes host weights, KV and compute", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
  });

  assert.equal(estimate.weightsBytesTotal, 3968);
  assert.equal(estimate.kvBytesTotal, 2 * (8 + 8) * 1024);
  assert.equal(estimate.computeBytesTotal, 100 * 512 * 4 + 2 * 8 * 512 * 4);
  assert.equal(estimate.confidence, "high");
  assert.equal(estimate.warnings.length, 0);
  assert.equal(estimate.pools.length, 1);
  assert.equal(estimate.pools[0]?.poolId, "host");
  assert.equal(estimate.draws.length, 1);
  assert.equal(estimate.draws[0]?.bytes, estimate.totalBytes);
});

test("estimateInstanceMemory refuses unknown GGML tensor types", () => {
  const tensors = syntheticTable();
  tensors.unknownTypeIds = [255];

  assert.throws(
    () =>
      estimateInstanceMemory({
        tensors,
        hparams: HPARAMS,
        args: {},
        pools: HOST_POOLS,
      }),
    /Main model contains unsupported GGML tensor type IDs: 255/,
  );
});

test("KV scales with context size", () => {
  const base = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const wide = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 512 },
    pools: HOST_POOLS,
  });
  assert.equal(wide.kvBytesTotal, base.kvBytesTotal * 2);
});

test("hybrid models warn and lose confidence when some layers lack KV", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: { ...HPARAMS, blockCount: 4 },
    args: {},
    pools: HOST_POOLS,
  });
  assert.equal(estimate.confidence, "medium");
  assert.ok(estimate.warnings.some((warning) => /Hybrid/.test(warning)));
});

test("hybrid recurrent models include SSM state in the context cache", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.ssm_conv1d.weight", [4, 8]),
  ]);
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: {
      ...HPARAMS,
      blockCount: 3,
      ssmConvKernel: 4,
      ssmGroupCount: 2,
      ssmInnerSize: 16,
      ssmStateSize: 8,
    },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  const attentionKv = 2 * (8 + 8) * 256;
  const nEmbdR = (4 - 1) * (16 + 2 * 2 * 8);
  const nEmbdS = 8 * 16;
  const recurrent = (nEmbdR + nEmbdS) * 4 * 4;
  assert.equal(estimate.kvBytesTotal, attentionKv + recurrent);
  assert.equal(estimate.confidence, "medium");
  assert.ok(
    estimate.warnings.some((warning) => /recurrent state/.test(warning)),
  );
});

test("recurrent state scales with --parallel", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.ssm_conv1d.weight", [4, 8]),
  ]);
  const hparams = {
    ...HPARAMS,
    blockCount: 3,
    ssmConvKernel: 4,
    ssmGroupCount: 2,
    ssmInnerSize: 16,
    ssmStateSize: 8,
  };
  const single = estimateInstanceMemory({
    tensors,
    hparams,
    args: { "--ctx-size": 256, "--parallel": 1 },
    pools: HOST_POOLS,
  });
  const quad = estimateInstanceMemory({
    tensors,
    hparams,
    args: { "--ctx-size": 256, "--parallel": 4 },
    pools: HOST_POOLS,
  });
  const attentionKv = 2 * (8 + 8) * 256;
  assert.equal(
    quad.kvBytesTotal - attentionKv * 4,
    (single.kvBytesTotal - attentionKv) * 4,
  );
});

test("LFM2 short-convolution layers include their recurrent state", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.shortconv.conv.weight", [3, 8]),
  ]);
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: {
      ...HPARAMS,
      architecture: "lfm2",
      blockCount: 3,
      shortConvCacheLength: 3,
    },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  const attentionKv = 2 * (8 + 8) * 256;
  const recurrent = 8 * (3 - 1) * 4 * 4;
  assert.equal(estimate.kvBytesTotal, attentionKv + recurrent);
  assert.ok(
    estimate.warnings.some((warning) => /recurrent state/.test(warning)),
  );
  assert.ok(!estimate.warnings.some((warning) => /not modeled/.test(warning)));
});

test("Kimi Linear KDA layers include convolution and matrix state", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.ssm_q_conv.weight", [4, 1, 8]),
    f16Tensor("blk.2.attn_k.weight", [8, 8]),
    f16Tensor("blk.2.attn_v.weight", [8, 8]),
    f16Tensor("blk.3.attn_kv_a_mqa.weight", [8, 6]),
  ]);
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: {
      ...HPARAMS,
      architecture: "kimi-linear",
      blockCount: 4,
      headCountKv: 0,
      attentionKeyLengthMla: 2,
      attentionValueLengthMla: 2,
      ssmConvKernel: 4,
      kdaHeadDim: 2,
    },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  const attentionKv = 2 * (8 + 8) * 256;
  const compressedMlaKv = 6 * 2 * 256;
  const recurrent = (3 * (4 - 1) * (4 * 2) + 2 * 2 * 4) * 4 * 4;
  assert.equal(
    estimate.kvBytesTotal,
    attentionKv + compressedMlaKv + recurrent,
  );
  assert.ok(
    estimate.warnings.some((warning) => /7|MLA|compressed K-only/.test(warning)),
  );
  assert.ok(!estimate.warnings.some((warning) => /not modeled/.test(warning)));
});

test("recurrent layers without SSM hparams stay unmodeled and low confidence", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.ssm_conv1d.weight", [4, 8]),
  ]);
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: { ...HPARAMS, blockCount: 3 },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  assert.equal(estimate.confidence, "low");
  assert.ok(estimate.warnings.some((warning) => /not modeled/.test(warning)));
});

test("sliding-window models flag KV as an upper bound", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: { ...HPARAMS, slidingWindow: 512 },
    args: {},
    pools: HOST_POOLS,
  });
  assert.equal(estimate.confidence, "medium");
  assert.ok(estimate.warnings.some((warning) => /upper bound/.test(warning)));
});

test("scalar-period SWA models cap only their sliding-window layers", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: {
      ...HPARAMS,
      architecture: "gpt-oss",
      slidingWindow: 128,
    },
    args: { "--ctx-size": 4096 },
    pools: HOST_POOLS,
  });

  const bytesPerTokenPerLayer = 8 + 8;
  const swaTokens = Math.ceil((128 * 4 + 512) / 256) * 256;
  assert.equal(
    estimate.kvBytesTotal,
    bytesPerTokenPerLayer * (swaTokens + 4096),
  );
  assert.ok(estimate.warnings.some((warning) => /capped/.test(warning)));
});

test("fused GPT-2 QKV tensors derive persistent cache geometry from heads", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.0.attn_qkv.weight", [8, 24]),
    f16Tensor("blk.1.attn_qkv.weight", [8, 24]),
  ]);
  tensors.tensors = tensors.tensors.filter(
    (tensor) => !/\.attn_[kv]\.weight$/.test(tensor.name),
  );
  tensors.tensorCount = tensors.tensors.length;
  tensors.totalBytes = tensors.tensors.reduce(
    (sum, tensor) => sum + tensor.bytes,
    0,
  );
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: { ...HPARAMS, architecture: "gpt2", headCountKv: null },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  assert.equal(estimate.kvBytesTotal, 2 * (16 + 16) * 256);
  assert.equal(estimate.confidence, "high");
});

test("legacy MLA uses metadata and compressed MLA uses projection geometry", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.0.attn_kv_a_mqa.weight", [8, 5]),
  ]);
  tensors.tensors = tensors.tensors.filter(
    (tensor) => !/\.attn_[kv]\.weight$/.test(tensor.name),
  );
  tensors.tensorCount = tensors.tensors.length;
  tensors.totalBytes = tensors.tensors.reduce(
    (sum, tensor) => sum + tensor.bytes,
    0,
  );
  const hparams = {
    ...HPARAMS,
    architecture: "deepseek2",
    blockCount: 1,
    headCount: 2,
    headCountKv: 2,
    attentionKeyLength: 3,
    attentionValueLength: 2,
  };
  const legacy = estimateInstanceMemory({
    tensors,
    hparams,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const compressed = estimateInstanceMemory({
    tensors,
    hparams: {
      ...hparams,
      attentionKeyLengthMla: 3,
      attentionValueLengthMla: 2,
    },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  assert.equal(legacy.kvBytesTotal, (12 + 8) * 256);
  assert.equal(compressed.kvBytesTotal, 10 * 256);
  assert.equal(legacy.confidence, "medium");
  assert.ok(legacy.warnings.some((warning) => /legacy K\/V/.test(warning)));
});

test("GPU MLA reserves host staging for quantized cache rows", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.0.attn_kv_a_mqa.weight", [8, 5]),
  ]);
  tensors.tensors = tensors.tensors.filter(
    (tensor) => !/\.attn_[kv]\.weight$/.test(tensor.name),
  );
  tensors.tensorCount = tensors.tensors.length;
  tensors.totalBytes = tensors.tensors.reduce(
    (sum, tensor) => sum + tensor.bytes,
    0,
  );
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: {
      ...HPARAMS,
      architecture: "deepseek2",
      blockCount: 1,
      headCount: 2,
      headCountKv: 2,
      attentionKeyLength: 3,
      attentionValueLength: 2,
      attentionKeyLengthMla: 3,
      attentionValueLengthMla: 2,
    },
    args: {
      "--ctx-size": 256,
      "--n-gpu-layers": 99,
      "--cache-type-k": "q8_0",
      "--cache-type-v": "q8_0",
    },
    pools: [
      { id: "gpu0", kind: "gpu", deviceIndex: 0 },
      { id: "host", kind: "host" },
    ],
  });

  const activation = 8 * 256 * 4;
  const mlaStaging = 2 * 34 * 256;
  const host = estimate.pools.find((pool) => pool.poolId === "host");
  const gpu = estimate.pools.find((pool) => pool.poolId === "gpu0");
  assert.equal(host?.computeBytes, mlaStaging);
  assert.equal(gpu?.computeBytes, 100 * 256 * 4 + 2 * activation);
  assert.equal(
    estimate.computeBytesTotal,
    100 * 256 * 4 + 2 * activation + mlaStaging,
  );
});

test("non-causal encoders have no persistent KV or vocabulary logits", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: { ...HPARAMS, architecture: "bert", causalAttention: false },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  assert.equal(estimate.kvBytesTotal, 0);
  assert.equal(estimate.computeBytesTotal, 2 * 8 * 256 * 4);
  assert.equal(estimate.confidence, "medium");
  assert.ok(
    estimate.warnings.some((warning) => /no persistent KV/.test(warning)),
  );
});

test("cacheless diffusion decoders retain vocabulary logits", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: { ...HPARAMS, architecture: "llada", causalAttention: false },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  assert.equal(estimate.kvBytesTotal, 0);
  assert.equal(
    estimate.computeBytesTotal,
    100 * 256 * 4 + 3 * 8 * 256 * 4,
  );
  assert.equal(estimate.confidence, "medium");
  assert.ok(
    estimate.warnings.some((warning) => /diffusion decoder/.test(warning)),
  );
  assert.ok(
    estimate.warnings.some((warning) => /classifier-free-guidance/.test(warning)),
  );
});

test("Mamba defaults the absent SSM group count to zero", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable([
      f16Tensor("blk.2.ssm_conv1d.weight", [4, 8]),
      f16Tensor("blk.2.attn_qkv.weight", [8, 24]),
    ]),
    hparams: {
      ...HPARAMS,
      architecture: "mamba",
      blockCount: 3,
      ssmConvKernel: 4,
      ssmGroupCount: null,
      ssmInnerSize: 16,
      ssmStateSize: 8,
    },
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });

  const attentionKv = 2 * (8 + 8) * 256;
  const recurrent = ((4 - 1) * 16 + 8 * 16) * 4 * 4;
  assert.equal(estimate.kvBytesTotal, attentionKv + recurrent);
});

test("RWKV state uses embedding width, head size, and token shifts", () => {
  const tensors = syntheticTable([f16Tensor("blk.0.time_mix.weight", [8])]);
  tensors.tensors = tensors.tensors.filter(
    (tensor) =>
      !tensor.name.startsWith("blk.1.") &&
      !/\.attn_[kv]\.weight$/.test(tensor.name),
  );
  tensors.tensorCount = tensors.tensors.length;
  tensors.totalBytes = tensors.tensors.reduce(
    (sum, tensor) => sum + tensor.bytes,
    0,
  );
  const estimate = estimateInstanceMemory({
    tensors,
    hparams: {
      ...HPARAMS,
      architecture: "rwkv7",
      blockCount: 1,
      wkvHeadSize: 4,
      tokenShiftCount: 2,
    },
    args: { "--parallel": 4 },
    pools: HOST_POOLS,
  });

  assert.equal(estimate.kvBytesTotal, (2 * 8 + 8 * 4) * 4 * 4);
  assert.equal(estimate.confidence, "medium");
});

function gemmaLikeTable(): GgufTensorTable {
  const tensors: GgufTensorInfo[] = [
    f16Tensor("token_embd.weight", [8, 100]),
    f16Tensor("output.weight", [8, 100]),
    f16Tensor("blk.0.attn_k.weight", [32, 16]),
    f16Tensor("blk.0.attn_v.weight", [32, 16]),
    f16Tensor("blk.1.attn_k.weight", [32, 8]),
    f16Tensor("blk.1.attn_v.weight", [32, 8]),
    f16Tensor("blk.2.attn_k.weight", [32, 16]),
    f16Tensor("blk.2.attn_v.weight", [32, 16]),
    f16Tensor("blk.3.attn_k.weight", [32, 8]),
    f16Tensor("blk.3.attn_v.weight", [32, 8]),
  ];
  return {
    path: "gemma.gguf",
    tensorCount: tensors.length,
    totalBytes: tensors.reduce((sum, tensor) => sum + tensor.bytes, 0),
    unknownTypeIds: [],
    tensors,
  };
}

test("SWA + KV sharing caps sliding-window layers and drops shared layers", () => {
  const estimate = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: {
      ...HPARAMS,
      blockCount: 4,
      slidingWindow: 1024,
      sharedKvLayers: 2,
    },
    args: {
      "--ctx-size": 8192,
      "--parallel": 2,
      "--kv-unified": true,
    },
    pools: HOST_POOLS,
  });

  const globalLayer = (16 * 2 + 16 * 2) * 8192;
  const swaTokens = Math.ceil((1024 * 2 + 512) / 256) * 256;
  const swaLayer = (8 * 2 + 8 * 2) * swaTokens;
  assert.equal(estimate.kvBytesTotal, globalLayer + swaLayer);
  assert.equal(estimate.confidence, "medium");
  assert.ok(estimate.warnings.some((warning) => /share KV/.test(warning)));
});

test("unified SWA cache reserves one ubatch beyond the sequence windows", () => {
  const wide = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: {
      ...HPARAMS,
      blockCount: 4,
      slidingWindow: 1024,
      sharedKvLayers: 2,
    },
    args: {
      "--ctx-size": 65536,
      "--parallel": 4,
      "--kv-unified": true,
    },
    pools: HOST_POOLS,
  });
  const narrow = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: {
      ...HPARAMS,
      blockCount: 4,
      slidingWindow: 1024,
      sharedKvLayers: 2,
    },
    args: {
      "--ctx-size": 65536,
      "--parallel": 1,
      "--kv-unified": true,
    },
    pools: HOST_POOLS,
  });
  const globalLayer = (16 * 2 + 16 * 2) * 65536;
  const wideSwa = Math.ceil((1024 * 4 + 512) / 256) * 256;
  const narrowSwa = Math.ceil((1024 + 512) / 256) * 256;
  assert.equal(wide.kvBytesTotal - globalLayer, 32 * wideSwa);
  assert.equal(narrow.kvBytesTotal - globalLayer, 32 * narrowSwa);
});

test("--swa-full expands sliding-window layers to the full context", () => {
  const estimate = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: {
      ...HPARAMS,
      blockCount: 4,
      slidingWindow: 1024,
      sharedKvLayers: 2,
    },
    args: {
      "--ctx-size": 65536,
      "--parallel": 4,
      "--swa-full": true,
    },
    pools: HOST_POOLS,
  });
  const globalLayer = (16 * 2 + 16 * 2) * 65536;
  const swaLayer = (8 * 2 + 8 * 2) * 65536;
  assert.equal(estimate.kvBytesTotal, globalLayer + swaLayer);
  assert.ok(estimate.warnings.some((warning) => /--swa-full/.test(warning)));
});

test("full GPU offload places weights, KV and compute on the GPU pool", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 99 },
    pools: [
      { id: "gpu0", kind: "gpu", deviceIndex: 0 },
      { id: "host", kind: "host" },
    ],
  });

  const gpu = estimate.pools.find((pool) => pool.poolId === "gpu0");
  const host = estimate.pools.find((pool) => pool.poolId === "host");
  assert.ok(gpu);
  assert.ok(gpu.kvBytes > 0);
  assert.ok(gpu.computeBytes > 0);
  assert.ok(gpu.overheadBytes > 0);
  assert.equal(
    host?.weightsBytes,
    f16Tensor("token_embd.weight", [8, 100]).bytes,
  );
  assert.equal(estimate.confidence, "medium");
});

test("full GPU offload duplicates a tied token embedding for output", () => {
  const tensors = syntheticTable();
  const outputBytes =
    tensors.tensors.find((tensor) => tensor.name === "output.weight")?.bytes ??
    0;
  tensors.tensors = tensors.tensors.filter(
    (tensor) => tensor.name !== "output.weight",
  );
  tensors.tensorCount = tensors.tensors.length;
  tensors.totalBytes -= outputBytes;
  const tokenBytes =
    tensors.tensors.find((tensor) => tensor.name === "token_embd.weight")
      ?.bytes ?? 0;

  const cpu = estimateInstanceMemory({
    tensors,
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 0 },
    pools: HOST_POOLS,
  });
  const gpu = estimateInstanceMemory({
    tensors,
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 99 },
    pools: [
      { id: "gpu0", kind: "gpu", deviceIndex: 0 },
      { id: "host", kind: "host" },
    ],
  });

  assert.equal(cpu.weightsBytesTotal, tensors.totalBytes);
  assert.equal(gpu.weightsBytesTotal, tensors.totalBytes + tokenBytes);
  assert.equal(
    gpu.pools.find((pool) => pool.poolId === "host")?.weightsBytes,
    tokenBytes,
  );
  assert.ok(
    gpu.warnings.some((warning) => /Tied output embedding/.test(warning)),
  );
});

test("upstream auto GPU layers use conservative full offload", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: [
      { id: "gpu0", kind: "gpu", deviceIndex: 0 },
      { id: "host", kind: "host" },
    ],
  });

  assert.equal(estimate.context.nGpuLayers, 3);
  assert.ok(
    (estimate.pools.find((pool) => pool.poolId === "gpu0")?.totalBytes ?? 0) >
      0,
  );
  assert.ok(estimate.warnings.some((warning) => /auto/.test(warning)));
});

test("no-kv-offload keeps KV on the host pool under GPU offload", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 99, "--no-kv-offload": "on" },
    pools: [
      { id: "gpu0", kind: "gpu", deviceIndex: 0 },
      { id: "host", kind: "host" },
    ],
  });

  const gpu = estimate.pools.find((pool) => pool.poolId === "gpu0");
  const host = estimate.pools.find((pool) => pool.poolId === "host");
  assert.equal(gpu?.kvBytes, 0);
  assert.ok((host?.kvBytes ?? 0) > 0);
});

test("multimodal projector weights are added to the footprint", () => {
  const mmproj = syntheticTable([f16Tensor("mm.proj.weight", [100, 100])]);
  const base = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
  });
  const withMmproj = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
    mmproj: { tensors: mmproj },
  });

  assert.equal(withMmproj.mmprojBytesTotal, mmproj.totalBytes);
  assert.equal(
    withMmproj.weightsBytesTotal,
    base.weightsBytesTotal + mmproj.totalBytes,
  );
  assert.equal(withMmproj.totalBytes, base.totalBytes + mmproj.totalBytes);
  assert.equal(base.confidence, "high");
  assert.equal(withMmproj.confidence, "medium");
  assert.ok(withMmproj.warnings.some((warning) => /projector/.test(warning)));
});

test("multimodal projector offloads to the GPU and respects --no-mmproj-offload", () => {
  const mmproj = syntheticTable();
  const pools = [
    { id: "gpu0", kind: "gpu" as const, deviceIndex: 0 },
    { id: "host", kind: "host" as const },
  ];
  const offloaded = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 0 },
    pools,
    mmproj: { tensors: mmproj },
  });
  const gpu = offloaded.pools.find((pool) => pool.poolId === "gpu0");
  assert.equal(gpu?.weightsBytes, mmproj.totalBytes);
  assert.ok((gpu?.overheadBytes ?? 0) > 0);

  const host = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--n-gpu-layers": 0, "--no-mmproj-offload": "on" },
    pools,
    mmproj: { tensors: mmproj },
  });
  assert.equal(
    host.pools.find((pool) => pool.poolId === "gpu0"),
    undefined,
  );
});

test("speculative draft model adds a second resident model", () => {
  const base = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const draftAlone = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const withDraft = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });

  const draftExpect =
    draftAlone.weightsBytesTotal +
    draftAlone.kvBytesTotal +
    draftAlone.computeBytesTotal;
  assert.equal(withDraft.draftBytesTotal, draftExpect);
  assert.equal(withDraft.totalBytes, base.totalBytes + draftExpect);
  assert.ok(withDraft.warnings.some((warning) => /draft/i.test(warning)));
});

test("draft model inherits SWA mode and all current draft KV aliases", () => {
  const draftHparams = {
    ...HPARAMS,
    blockCount: 4,
    slidingWindow: 1024,
    sharedKvLayers: 2,
  };
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {
      "--ctx-size": 8192,
      "--parallel": 2,
      "--swa-full": true,
      "-ctkd": "f32",
      "--cache-type-v-draft": "f32",
    },
    pools: HOST_POOLS,
    draft: { tensors: gemmaLikeTable(), hparams: draftHparams },
  });

  const draftAlone = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: draftHparams,
    args: {
      "--ctx-size": 8192,
      "--parallel": 2,
      "--swa-full": true,
      "--cache-type-k": "f32",
      "--cache-type-v": "f32",
    },
    pools: HOST_POOLS,
  });
  assert.equal(
    estimate.draftBytesTotal,
    draftAlone.weightsBytesTotal +
      draftAlone.kvBytesTotal +
      draftAlone.computeBytesTotal,
  );
  assert.ok(
    estimate.warnings.some(
      (warning) => /Draft model:.*--swa-full/.test(warning),
    ),
  );
});

test("special speculative families disclose unmodeled runtime scratch", () => {
  const dflash = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--spec-type": "draft-dflash" },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });
  assert.equal(dflash.confidence, "medium");
  assert.ok(dflash.warnings.some((warning) => /DFlash.*scratch/.test(warning)));

  const eagle3 = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--spec-type": "draft-eagle3" },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });
  assert.equal(eagle3.confidence, "low");
  assert.ok(eagle3.warnings.some((warning) => /Eagle3/.test(warning)));

  const dspark = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--spec-type": "draft-dspark" },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });
  assert.equal(dspark.confidence, "medium");
  assert.ok(dspark.warnings.some((warning) => /DSpark.*scratch/.test(warning)));
});

test("built-in MTP adds a second context without duplicating target weights", () => {
  const tensors = syntheticTable([
    f16Tensor("blk.2.attn_k.weight", [8, 4]),
    f16Tensor("blk.2.attn_v.weight", [8, 4]),
    f16Tensor("blk.2.ffn_down.weight", [16, 8]),
    f16Tensor("blk.2.nextn.eh_proj.weight", [16, 8]),
  ]);
  const hparams = {
    ...HPARAMS,
    blockCount: 3,
    nextnPredictLayers: 1,
  };
  const base = estimateInstanceMemory({
    tensors,
    hparams,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const mtp = estimateInstanceMemory({
    tensors,
    hparams,
    args: { "--ctx-size": 256, "--spec-type": "draft-mtp" },
    pools: HOST_POOLS,
  });

  const mtpKv = (8 + 8) * 256;
  const mtpCompute = 100 * 256 * 4 + 2 * 8 * 256 * 4;
  assert.equal(base.kvBytesTotal, 2 * mtpKv);
  assert.equal(mtp.weightsBytesTotal, base.weightsBytesTotal);
  assert.equal(mtp.kvBytesTotal, base.kvBytesTotal + mtpKv);
  assert.equal(mtp.selfMtpBytesTotal, mtpKv + mtpCompute);
  assert.equal(mtp.totalBytes, base.totalBytes + mtp.selfMtpBytesTotal);
  assert.ok(mtp.warnings.some((warning) => /Built-in MTP/.test(warning)));
});

test("Gemma 4 assistant reuses the target KV cache", () => {
  const draftHparams = {
    ...HPARAMS,
    architecture: "gemma4-assistant",
    nextnPredictLayers: 2,
  };
  const draftAlone = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: draftHparams,
    args: { "--ctx-size": 256 },
    pools: HOST_POOLS,
  });
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256, "--spec-type": "draft-mtp" },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: draftHparams },
  });

  assert.equal(
    estimate.draftBytesTotal,
    draftAlone.weightsBytesTotal + draftAlone.computeBytesTotal,
  );
  assert.ok(
    estimate.warnings.some((warning) =>
      /reuses the target context/.test(warning),
    ),
  );
});

test("draft-mtp without NextN metadata is reported as incomplete", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--spec-type": "draft-mtp" },
    pools: HOST_POOLS,
  });

  assert.equal(estimate.selfMtpBytesTotal, 0);
  assert.equal(estimate.confidence, "low");
  assert.ok(estimate.warnings.some((warning) => /no MTP layers/.test(warning)));
});

test("LoRA tensors and the combined control-vector buffer are resident", () => {
  const loraTensors = [
    f16Tensor("blk.0.attn_q.weight.lora_a", [8, 2]),
    f16Tensor("blk.0.attn_q.weight.lora_b", [2, 8]),
  ];
  const lora: GgufTensorTable = {
    path: "adapter.gguf",
    tensorCount: loraTensors.length,
    totalBytes: loraTensors.reduce((sum, tensor) => sum + tensor.bytes, 0),
    unknownTypeIds: [],
    tensors: loraTensors,
  };
  const base = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
  });
  const supplemented = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
    loras: [{ tensors: lora }],
    controlVector: true,
  });

  const controlVectorBytes = (2 - 1) * 8 * 4;
  assert.equal(supplemented.loraBytesTotal, lora.totalBytes);
  assert.equal(supplemented.controlVectorBytesTotal, controlVectorBytes);
  assert.equal(
    supplemented.totalBytes,
    base.totalBytes + lora.totalBytes + controlVectorBytes,
  );
});

test("control vectors exclude embedded NextN layers", () => {
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: { ...HPARAMS, nextnPredictLayers: 1 },
    args: {},
    pools: HOST_POOLS,
    controlVector: true,
  });

  assert.equal(estimate.controlVectorBytesTotal, 0);
});

test("draft model honors --spec-draft-ngl independently of the main model", () => {
  const pools = [
    { id: "gpu0", kind: "gpu" as const, deviceIndex: 0 },
    { id: "host", kind: "host" as const },
  ];
  const estimate = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--ctx-size": 256, "--spec-draft-ngl": 99 },
    pools,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });

  const gpu = estimate.pools.find((pool) => pool.poolId === "gpu0");
  const host = estimate.pools.find((pool) => pool.poolId === "host");
  assert.ok(gpu);
  assert.ok(gpu.weightsBytes > 0);
  assert.ok((host?.weightsBytes ?? 0) > 0);
});

test("unsupported placement overrides fail confidence closed", () => {
  const mainOverride = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--split-mode": "row", "--override-tensor": "blk.*=CPU" },
    pools: HOST_POOLS,
  });
  assert.equal(mainOverride.confidence, "low");
  assert.ok(
    mainOverride.warnings.some((warning) => /layer splitting only/.test(warning)),
  );
  assert.ok(
    mainOverride.warnings.some((warning) => /individual tensor/.test(warning)),
  );

  const draftOverride = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--spec-draft-device": "CUDA1" },
    pools: HOST_POOLS,
    draft: { tensors: syntheticTable(), hparams: HPARAMS },
  });
  assert.equal(draftOverride.confidence, "low");
  assert.ok(
    draftOverride.warnings.some((warning) => /draft device list/.test(warning)),
  );

  const rpc = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: {},
    pools: HOST_POOLS,
    rpcWorkerCount: 1,
  });
  assert.equal(rpc.confidence, "low");
  assert.ok(rpc.warnings.some((warning) => /RPC devices/.test(warning)));
});

test("known specialized cache architectures fail confidence closed", () => {
  for (const architecture of [
    "minimax-m3",
    "glm-dsa",
    "deepseek32",
    "deepseek4",
  ]) {
    const estimate = estimateInstanceMemory({
      tensors: syntheticTable(),
      hparams: { ...HPARAMS, architecture },
      args: {},
      pools: HOST_POOLS,
    });
    assert.equal(estimate.confidence, "low");
    assert.ok(
      estimate.warnings.some((warning) => /indexer|DSV4/.test(warning)),
    );
  }
});
