import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ggmlRowSizeBytes,
  ggmlTensorBytes,
  ggmlTypeName,
  ggufModelRole,
  ggufPoolingTypeLabel,
} from "@arriero/core";

import {
  ggufFileTypeLabel,
  readGgufMetadata,
  readGgufModelTensorTable,
  readGgufTensorTable,
  resolveGgufShardPaths,
} from "./gguf.js";

test("ggufFileTypeLabel maps llama.cpp file types", () => {
  assert.equal(ggufFileTypeLabel(2), "Q4_0");
  assert.equal(ggufFileTypeLabel(10), "Q2_K");
  assert.equal(ggufFileTypeLabel(15), "Q4_K_M");
  assert.equal(ggufFileTypeLabel(36), "TQ1_0");
  assert.equal(ggufFileTypeLabel(37), "TQ2_0");
  assert.equal(ggufFileTypeLabel(41), "Q2_0");
  assert.equal(ggufFileTypeLabel(1024 | 10), "Q2_K (guessed)");
  assert.equal(ggufFileTypeLabel(999), null);
});

test("ggml type sizing matches ggml block math", () => {
  assert.equal(ggmlTypeName(1), "f16");
  assert.equal(ggmlTypeName(2), "q4_0");
  assert.equal(ggmlTypeName(255), null);

  assert.equal(ggmlRowSizeBytes(0, 10), 40);
  assert.equal(ggmlRowSizeBytes(1, 10), 20);
  assert.equal(ggmlRowSizeBytes(2, 32), 18);
  assert.equal(ggmlRowSizeBytes(8, 64), 68);
  assert.equal(ggmlRowSizeBytes(34, 256), 54);
  assert.equal(ggmlRowSizeBytes(35, 256), 66);
  assert.equal(ggmlRowSizeBytes(41, 128), 18);
  assert.equal(ggmlRowSizeBytes(42, 64), 18);
  assert.equal(ggmlRowSizeBytes(255, 32), null);

  assert.equal(ggmlTensorBytes(1, [4, 8]), 64);
  assert.equal(ggmlTensorBytes(2, [32, 2]), 36);
  assert.equal(ggmlTensorBytes(14, [256, 4]), 840);
});

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

function tensorInfo(name: string, dims: number[], typeId: number) {
  return Buffer.concat([
    ggufString(name),
    u32(dims.length),
    ...dims.map((dim) => u64(dim)),
    u32(typeId),
    u64(0),
  ]);
}

test("readGgufTensorTable parses the tensor section and sizes tensors", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-"));
  const path = join(dir, "synthetic.gguf");
  try {
    const file = Buffer.concat([
      Buffer.from("GGUF", "utf8"),
      u32(3),
      u64(2),
      u64(0),
      tensorInfo("token_embd.weight", [4, 8], 1),
      tensorInfo("blk.0.ffn_down.weight", [32, 2], 2),
    ]);
    writeFileSync(path, file);

    const table = readGgufTensorTable(path);
    assert.equal(table.tensorCount, 2);
    assert.deepEqual(table.unknownTypeIds, []);
    assert.equal(table.totalBytes, 100);
    assert.equal(table.tensors.length, 2);

    const embd = table.tensors[0];
    assert.equal(embd?.name, "token_embd.weight");
    assert.equal(embd?.type, "f16");
    assert.deepEqual(embd?.dims, [4, 8]);
    assert.equal(embd?.elements, 32);
    assert.equal(embd?.bytes, 64);

    const ffn = table.tensors[1];
    assert.equal(ffn?.name, "blk.0.ffn_down.weight");
    assert.equal(ffn?.type, "q4_0");
    assert.equal(ffn?.bytes, 36);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function shardFile(tensors: Buffer[]) {
  return Buffer.concat([
    Buffer.from("GGUF", "utf8"),
    u32(3),
    u64(tensors.length),
    u64(0),
    ...tensors,
  ]);
}

test("readGgufModelTensorTable sums every shard of a split GGUF", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-split-"));
  const shard1 = join(dir, "model-00001-of-00002.gguf");
  const shard2 = join(dir, "model-00002-of-00002.gguf");
  try {
    writeFileSync(
      shard1,
      shardFile([tensorInfo("blk.0.attn_k.weight", [4, 8], 1)]),
    );
    writeFileSync(
      shard2,
      shardFile([
        tensorInfo("blk.1.attn_k.weight", [4, 8], 1),
        tensorInfo("blk.1.ffn_down.weight", [32, 2], 2),
      ]),
    );

    assert.deepEqual(resolveGgufShardPaths(shard1), [shard1, shard2]);

    const single = readGgufTensorTable(shard1);
    assert.equal(single.tensorCount, 1);
    assert.equal(single.totalBytes, 64);

    const full = readGgufModelTensorTable(shard1);
    assert.equal(full.path, shard1);
    assert.equal(full.tensorCount, 3);
    assert.equal(full.totalBytes, 64 + 64 + 36);
    assert.deepEqual(
      full.tensors.map((tensor) => tensor.name),
      ["blk.0.attn_k.weight", "blk.1.attn_k.weight", "blk.1.ffn_down.weight"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGgufShardPaths returns the lone path for non-split models", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-plain-"));
  const path = join(dir, "plain.gguf");
  try {
    writeFileSync(
      path,
      shardFile([tensorInfo("blk.0.attn_k.weight", [4, 8], 1)]),
    );
    assert.deepEqual(resolveGgufShardPaths(path), [path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function kvString(key: string, value: string) {
  return Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
}

function kvU32(key: string, value: number) {
  return Buffer.concat([ggufString(key), u32(4), u32(value)]);
}

function kvBool(key: string, value: boolean) {
  return Buffer.concat([ggufString(key), u32(7), Buffer.from([value ? 1 : 0])]);
}

function f32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function kvFloat(key: string, value: number) {
  return Buffer.concat([ggufString(key), u32(6), f32(value)]);
}

function kvStringArray(key: string, values: string[]) {
  return Buffer.concat([
    ggufString(key),
    u32(9),
    u32(8),
    u64(values.length),
    ...values.map(ggufString),
  ]);
}

function kvBoolArray(key: string, values: boolean[]) {
  return Buffer.concat([
    ggufString(key),
    u32(9),
    u32(7),
    u64(values.length),
    Buffer.from(values.map((value) => (value ? 1 : 0))),
  ]);
}

function metadataFile(kvs: Buffer[], tensors: Buffer[] = []) {
  return Buffer.concat([
    Buffer.from("GGUF", "utf8"),
    u32(3),
    u64(tensors.length),
    u64(kvs.length),
    ...kvs,
    ...tensors,
  ]);
}

function truncatedTensorTableFile(kvs: Buffer[], declaredTensorCount: number) {
  return Buffer.concat([
    Buffer.from("GGUF", "utf8"),
    u32(3),
    u64(declaredTensorCount),
    u64(kvs.length),
    ...kvs,
  ]);
}

test("readGgufMetadata captures embedding role signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-meta-"));
  const path = join(dir, "embedding.gguf");
  try {
    writeFileSync(
      path,
      metadataFile([
        kvString("general.architecture", "bert"),
        kvString("general.type", "model"),
        kvU32("bert.block_count", 24),
        kvU32("bert.embedding_length", 1024),
        kvBool("bert.attention.causal", false),
        kvU32("bert.pooling_type", 2),
      ]),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.architecture, "bert");
    assert.equal(metadata.modelType, "model");
    assert.equal(metadata.poolingType, 2);
    assert.equal(metadata.causalAttention, false);
    assert.equal(metadata.embeddingLength, 1024);
    assert.equal(metadata.hasClassifierHead, false);
    assert.equal(ggufModelRole(metadata), "embedding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGgufMetadata detects reranker via classifier head tensor", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-rerank-"));
  const path = join(dir, "reranker.gguf");
  try {
    writeFileSync(
      path,
      metadataFile(
        [
          kvString("general.architecture", "bert"),
          kvString("general.type", "model"),
          kvU32("bert.embedding_length", 1024),
          kvBool("bert.attention.causal", false),
        ],
        [
          tensorInfo("token_embd.weight", [4, 8], 1),
          tensorInfo("cls.weight", [4, 4], 1),
        ],
      ),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.poolingType, null);
    assert.equal(metadata.causalAttention, false);
    assert.equal(metadata.hasClassifierHead, true);
    assert.equal(ggufModelRole(metadata), "reranker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGgufMetadata reports an unreadable tensor table as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-truncated-"));
  const path = join(dir, "truncated.gguf");
  try {
    writeFileSync(
      path,
      truncatedTensorTableFile(
        [
          kvString("general.architecture", "bert"),
          kvString("general.type", "model"),
          kvBool("bert.attention.causal", false),
        ],
        2,
      ),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.architecture, "bert");
    assert.equal(metadata.parameterCount, null);
    assert.equal(metadata.hasClassifierHead, null);
    assert.notEqual(metadata.hasClassifierHead, false);
    assert.equal(ggufModelRole(metadata), "embedding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGgufMetadata leaves generative models without pooling signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-gen-"));
  const path = join(dir, "generative.gguf");
  try {
    writeFileSync(
      path,
      metadataFile([
        kvString("general.architecture", "qwen2"),
        kvString("general.type", "model"),
        kvU32("qwen2.block_count", 24),
      ]),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.poolingType, null);
    assert.equal(metadata.causalAttention, null);
    assert.equal(ggufModelRole(metadata), "generative");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGgufMetadata captures cache and recurrent geometry", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-memory-meta-"));
  const path = join(dir, "memory.gguf");
  try {
    writeFileSync(
      path,
      metadataFile([
        kvString("general.architecture", "rwkv7"),
        kvU32("rwkv7.attention.key_length", 192),
        kvU32("rwkv7.attention.value_length", 128),
        kvU32("rwkv7.attention.key_length_mla", 128),
        kvU32("rwkv7.attention.value_length_mla", 128),
        kvU32("rwkv7.attention.sliding_window", 512),
        kvU32("rwkv7.nextn_predict_layers", 1),
        kvU32("rwkv7.shortconv.l_cache", 3),
        kvBoolArray("rwkv7.attention.sliding_window_pattern", [
          true,
          false,
          true,
        ]),
        kvU32("rwkv7.wkv.head_size", 64),
        kvU32("rwkv7.token_shift_count", 2),
        kvU32("rwkv7.kda.head_dim", 128),
      ]),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.attentionKeyLength, 192);
    assert.equal(metadata.attentionValueLength, 128);
    assert.equal(metadata.attentionKeyLengthMla, 128);
    assert.equal(metadata.attentionValueLengthMla, 128);
    assert.equal(metadata.slidingWindow, 512);
    assert.equal(metadata.nextnPredictLayers, 1);
    assert.equal(metadata.shortConvCacheLength, 3);
    assert.deepEqual(metadata.slidingWindowPattern, [true, false, true]);
    assert.equal(metadata.wkvHeadSize, 64);
    assert.equal(metadata.tokenShiftCount, 2);
    assert.equal(metadata.kdaHeadDim, 128);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ggufModelRole classifies pooling and attention combinations", () => {
  assert.equal(
    ggufModelRole({
      poolingType: 4,
      causalAttention: false,
      hasClassifierHead: false,
    }),
    "reranker",
  );
  assert.equal(
    ggufModelRole({
      poolingType: null,
      causalAttention: false,
      hasClassifierHead: true,
    }),
    "reranker",
  );
  assert.equal(
    ggufModelRole({
      poolingType: 2,
      causalAttention: false,
      hasClassifierHead: false,
    }),
    "embedding",
  );
  assert.equal(
    ggufModelRole({
      poolingType: 3,
      causalAttention: true,
      hasClassifierHead: false,
    }),
    "embedding",
  );
  assert.equal(
    ggufModelRole({
      poolingType: null,
      causalAttention: false,
      hasClassifierHead: false,
    }),
    "embedding",
  );
  assert.equal(
    ggufModelRole({
      poolingType: 0,
      causalAttention: null,
      hasClassifierHead: false,
    }),
    "generative",
  );
  assert.equal(
    ggufModelRole({
      poolingType: null,
      causalAttention: null,
      hasClassifierHead: false,
    }),
    "generative",
  );
  assert.equal(
    ggufModelRole({
      poolingType: null,
      causalAttention: null,
      hasClassifierHead: null,
    }),
    "generative",
  );
  assert.equal(
    ggufModelRole({
      poolingType: 4,
      causalAttention: null,
      hasClassifierHead: null,
    }),
    "reranker",
  );
});

test("readGgufMetadata captures provenance, sampling and imatrix", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-prov-"));
  const path = join(dir, "provenance.gguf");
  try {
    writeFileSync(
      path,
      metadataFile([
        kvString("general.architecture", "gemma4"),
        kvString("general.license", "apache-2.0"),
        kvString("general.quantized_by", "Unsloth"),
        kvStringArray("general.tags", ["unsloth", "gemma"]),
        kvU32("general.base_model.count", 1),
        kvString("general.base_model.0.name", "Gemma 4 E2B It"),
        kvString("general.base_model.0.organization", "Google"),
        kvString(
          "general.base_model.0.repo_url",
          "https://huggingface.co/google/gemma-4-E2B-it",
        ),
        kvFloat("general.sampling.temp", 1),
        kvU32("general.sampling.top_k", 64),
        kvString("quantize.imatrix.dataset", "calib.txt"),
        kvU32("quantize.imatrix.entries_count", 275),
        kvU32("quantize.imatrix.chunks_count", 141),
      ]),
    );

    const metadata = readGgufMetadata(path);
    assert.equal(metadata.license, "apache-2.0");
    assert.equal(metadata.quantizedBy, "Unsloth");
    assert.deepEqual(metadata.tags, ["unsloth", "gemma"]);
    assert.equal(metadata.baseModels.length, 1);
    assert.equal(metadata.baseModels[0]?.name, "Gemma 4 E2B It");
    assert.equal(metadata.baseModels[0]?.organization, "Google");
    assert.equal(
      metadata.baseModels[0]?.repoUrl,
      "https://huggingface.co/google/gemma-4-E2B-it",
    );
    assert.equal(metadata.samplingTemp, 1);
    assert.equal(metadata.samplingTopK, 64);
    assert.equal(metadata.imatrixDataset, "calib.txt");
    assert.equal(metadata.imatrixEntries, 275);
    assert.equal(metadata.imatrixChunks, 141);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ggufPoolingTypeLabel maps llama.cpp pooling enum values", () => {
  assert.equal(ggufPoolingTypeLabel(2), "cls");
  assert.equal(ggufPoolingTypeLabel(1), "mean");
  assert.equal(ggufPoolingTypeLabel(4), "rank");
  assert.equal(ggufPoolingTypeLabel(-1), "unspecified");
  assert.equal(ggufPoolingTypeLabel(9), "type 9");
  assert.equal(ggufPoolingTypeLabel(null), null);
});
