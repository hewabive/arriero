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
  contextLength: 1024,
  slidingWindow: null,
  sharedKvLayers: null,
  ssmConvKernel: null,
  ssmGroupCount: null,
  ssmInnerSize: null,
  ssmStateSize: null,
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
      "--no-kv-offload": "on",
      "--n-gpu-layers": 99,
    },
    HPARAMS,
  );
  assert.equal(ctx.nCtx, 2048);
  assert.equal(ctx.nUbatch, 256);
  assert.equal(ctx.typeK, "q8_0");
  assert.equal(ctx.offloadKqv, false);
  assert.equal(ctx.nGpuLayers, 3);
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
  assert.equal(estimate.computeBytesTotal, 100 * 512 * 4 + 8 * 512 * 4);
  assert.equal(estimate.confidence, "high");
  assert.equal(estimate.warnings.length, 0);
  assert.equal(estimate.pools.length, 1);
  assert.equal(estimate.pools[0]?.poolId, "host");
  assert.equal(estimate.draws.length, 1);
  assert.equal(estimate.draws[0]?.bytes, estimate.totalBytes);
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
    quad.kvBytesTotal - attentionKv,
    (single.kvBytesTotal - attentionKv) * 4,
  );
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
    args: { "--ctx-size": 8192, "--parallel": 2 },
    pools: HOST_POOLS,
  });

  const globalLayer = (16 * 2 + 16 * 2) * 8192;
  const swaPad = Math.ceil((1024 + 512) / 256) * 256;
  const swaTokens = Math.min(8192, 2 * swaPad);
  const swaLayer = (8 * 2 + 8 * 2) * swaTokens;
  assert.equal(estimate.kvBytesTotal, globalLayer + swaLayer);
  assert.equal(estimate.confidence, "medium");
  assert.ok(estimate.warnings.some((warning) => /share KV/.test(warning)));
});

test("SWA cache scales with --parallel and is capped by context", () => {
  const wide = estimateInstanceMemory({
    tensors: gemmaLikeTable(),
    hparams: {
      ...HPARAMS,
      blockCount: 4,
      slidingWindow: 1024,
      sharedKvLayers: 2,
    },
    args: { "--ctx-size": 65536, "--parallel": 4 },
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
    args: { "--ctx-size": 65536, "--parallel": 1 },
    pools: HOST_POOLS,
  });
  const globalLayer = (16 * 2 + 16 * 2) * 65536;
  const swaPad = Math.ceil((1024 + 512) / 256) * 256;
  assert.equal(wide.kvBytesTotal - globalLayer, 32 * 4 * swaPad);
  assert.equal(
    wide.kvBytesTotal - globalLayer,
    (narrow.kvBytesTotal - globalLayer) * 4,
  );
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
    args: {},
    pools,
    mmproj: { tensors: mmproj },
  });
  const gpu = offloaded.pools.find((pool) => pool.poolId === "gpu0");
  assert.equal(gpu?.weightsBytes, mmproj.totalBytes);
  assert.ok((gpu?.overheadBytes ?? 0) > 0);

  const host = estimateInstanceMemory({
    tensors: syntheticTable(),
    hparams: HPARAMS,
    args: { "--no-mmproj-offload": "on" },
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
