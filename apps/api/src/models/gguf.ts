import type {
  GgufBaseModel,
  GgufMetadata,
  GgufTensorInfo,
  GgufTensorTable,
  MemoryEstimateHparams,
} from "@arriero/core";
import { ggmlTensorBytes, ggmlTypeName } from "@arriero/core";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { logger } from "../logger.js";
import { extractChatTemplateReasoning } from "./chat-template-reasoning.js";
import { parseSplitInfo, splitShardName } from "./split.js";

type GgufScalar = string | number | boolean | null;
type GgufValue = GgufScalar | GgufScalar[];

export type GgufRawFacts = {
  kv: Array<[string, GgufValue]>;
  tensors: {
    parameterCount: number | null;
    hasClassifierHead: boolean;
    elementsByType: Array<[number, number]>;
  } | null;
};

const STRING_ARRAY_CAPTURE_LIMIT = 64;
const METADATA_ARRAY_CAPTURE_LIMIT = 4096;

const GGUF_VALUE_SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};

const GGUF_FILE_TYPES: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
};

const LLAMA_FTYPE_GUESSED = 1024;

const LLAMA_FTYPE_EXPECTED_GGML_TYPES: Record<number, number[]> = {
  0: [0],
  1: [1],
  2: [2],
  3: [3],
  7: [8],
  8: [6],
  9: [7],
  10: [10],
  11: [11],
  12: [11],
  13: [11],
  14: [12],
  15: [12],
  16: [13],
  17: [13],
  18: [14],
  19: [16],
  20: [17],
  21: [10],
  22: [18, 21],
  23: [18],
  24: [19],
  25: [20],
  26: [21],
  27: [21],
  28: [17, 22],
  29: [22],
  30: [23],
  31: [29],
  32: [30],
  36: [34],
  37: [35],
  38: [39],
  39: [40],
  40: [41],
  41: [42],
};

const FILE_TYPE_TENSOR_SHARE_FLOOR = 0.05;

const READ_CHUNK_BYTES = 1 << 20;

class FileReader {
  private offset = 0;
  private chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private chunkOffset = 0;
  private chunkLength = 0;

  constructor(private readonly fd: number) {}

  read(length: number) {
    const start = this.offset - this.chunkOffset;
    if (start >= 0 && start + length <= this.chunkLength) {
      this.offset += length;
      return this.chunk.subarray(start, start + length);
    }
    if (length > this.chunk.length) {
      const buffer = Buffer.alloc(length);
      this.readExact(buffer, length, this.offset);
      this.offset += length;
      return buffer;
    }
    this.fillChunk(length);
    this.offset += length;
    return this.chunk.subarray(0, length);
  }

  skip(length: number) {
    this.offset += length;
  }

  private fillChunk(minLength: number) {
    this.chunkOffset = this.offset;
    this.chunkLength = 0;
    while (this.chunkLength < this.chunk.length) {
      const bytesRead = readSync(
        this.fd,
        this.chunk,
        this.chunkLength,
        this.chunk.length - this.chunkLength,
        this.chunkOffset + this.chunkLength,
      );
      if (bytesRead === 0) {
        break;
      }
      this.chunkLength += bytesRead;
    }
    if (this.chunkLength < minLength) {
      throw new Error("unexpected end of GGUF file");
    }
  }

  private readExact(buffer: Buffer, length: number, position: number) {
    let filled = 0;
    while (filled < length) {
      const bytesRead = readSync(
        this.fd,
        buffer,
        filled,
        length - filled,
        position + filled,
      );
      if (bytesRead === 0) {
        throw new Error("unexpected end of GGUF file");
      }
      filled += bytesRead;
    }
  }

  string() {
    const length = this.u64Number();
    return this.read(length).toString("utf8");
  }

  u32() {
    return this.read(4).readUInt32LE(0);
  }

  i32() {
    return this.read(4).readInt32LE(0);
  }

  u64() {
    return this.read(8).readBigUInt64LE(0);
  }

  i64() {
    return this.read(8).readBigInt64LE(0);
  }

  u64Number() {
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`GGUF integer is too large: ${value.toString()}`);
    }
    return Number(value);
  }
}

function readScalar(reader: FileReader, type: number): GgufScalar {
  if (type === 0) return reader.read(1).readUInt8(0);
  if (type === 1) return reader.read(1).readInt8(0);
  if (type === 2) return reader.read(2).readUInt16LE(0);
  if (type === 3) return reader.read(2).readInt16LE(0);
  if (type === 4) return reader.u32();
  if (type === 5) return reader.i32();
  if (type === 6) return reader.read(4).readFloatLE(0);
  if (type === 7) return reader.read(1).readUInt8(0) !== 0;
  if (type === 8) return reader.string();
  if (type === 10) {
    const value = reader.u64();
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  if (type === 11) {
    const value = reader.i64();
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    return value <= max && value >= min ? Number(value) : null;
  }
  if (type === 12) return reader.read(8).readDoubleLE(0);
  throw new Error(`unsupported GGUF metadata type: ${type}`);
}

function readValue(
  reader: FileReader,
  type: number,
  captureArray = false,
): GgufValue {
  if (type !== 9) {
    return readScalar(reader, type);
  }

  const elementType = reader.u32();
  const count = reader.u64Number();
  if (elementType === 8) {
    if (count <= STRING_ARRAY_CAPTURE_LIMIT) {
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        values.push(reader.string());
      }
      return values;
    }
    for (let index = 0; index < count; index += 1) {
      reader.skip(reader.u64Number());
    }
    return captureArray ? null : count;
  }

  const size = GGUF_VALUE_SIZE[elementType];
  if (!size) {
    throw new Error(`unsupported GGUF array type: ${elementType}`);
  }

  if (captureArray && count <= METADATA_ARRAY_CAPTURE_LIMIT) {
    const values: GgufScalar[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(readScalar(reader, elementType));
    }
    return values;
  }

  if (captureArray) {
    reader.skip(count * size);
    return null;
  }
  if (count === 0) {
    return null;
  }
  const first = readScalar(reader, elementType);
  reader.skip((count - 1) * size);
  return first;
}

function numberMetadata(metadata: Map<string, GgufValue>, keys: string[]) {
  for (const key of keys) {
    const value = metadata.get(key);
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

function stringMetadata(metadata: Map<string, GgufValue>, keys: string[]) {
  for (const key of keys) {
    const value = metadata.get(key);
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function findNumberBySuffix(metadata: Map<string, GgufValue>, suffix: string) {
  for (const [key, value] of metadata.entries()) {
    if (key.endsWith(suffix) && typeof value === "number") {
      return value;
    }
  }
  return null;
}

function findStringBySuffix(metadata: Map<string, GgufValue>, suffix: string) {
  for (const [key, value] of metadata.entries()) {
    if (key.endsWith(suffix) && typeof value === "string") {
      return value;
    }
  }
  return null;
}

function findBooleanBySuffix(metadata: Map<string, GgufValue>, suffix: string) {
  for (const [key, value] of metadata.entries()) {
    if (key.endsWith(suffix) && typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function findSwaPattern(metadata: Map<string, GgufValue>) {
  for (const [key, value] of metadata.entries()) {
    if (!key.endsWith(".attention.sliding_window_pattern")) {
      continue;
    }
    if (typeof value === "number") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(
        (item) => item === true || (typeof item === "number" && item !== 0),
      );
    }
  }
  return null;
}

function stringArrayMetadata(metadata: Map<string, GgufValue>, keys: string[]) {
  for (const key of keys) {
    const value = metadata.get(key);
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}

function readBaseModels(metadata: Map<string, GgufValue>): GgufBaseModel[] {
  const count = numberMetadata(metadata, ["general.base_model.count"]);
  if (count === null || count <= 0) {
    return [];
  }
  const models: GgufBaseModel[] = [];
  for (let index = 0; index < Math.min(count, 16); index += 1) {
    const name = stringMetadata(metadata, [`general.base_model.${index}.name`]);
    const organization = stringMetadata(metadata, [
      `general.base_model.${index}.organization`,
    ]);
    const repoUrl = stringMetadata(metadata, [
      `general.base_model.${index}.repo_url`,
    ]);
    if (name === null && organization === null && repoUrl === null) {
      continue;
    }
    models.push({ name, organization, repoUrl });
  }
  return models;
}

export function ggufFileTypeLabel(fileType: number) {
  const guessed = (fileType & LLAMA_FTYPE_GUESSED) === LLAMA_FTYPE_GUESSED;
  const normalized = guessed ? fileType & ~LLAMA_FTYPE_GUESSED : fileType;
  const label = GGUF_FILE_TYPES[normalized];
  if (!label) {
    return null;
  }
  return guessed ? `${label} (guessed)` : label;
}

function dominantTensorTypeLabel(elementsByType: Map<number, number>) {
  let dominant: { typeId: number; elements: number } | null = null;
  for (const [typeId, elements] of elementsByType.entries()) {
    if (!dominant || elements > dominant.elements) {
      dominant = { typeId, elements };
    }
  }
  if (!dominant) {
    return null;
  }
  const name = ggmlTypeName(dominant.typeId);
  return name ? `${name.toUpperCase()} (tensors)` : null;
}

function fileTypeMatchesTensors(
  fileType: number,
  elementsByType: Map<number, number>,
) {
  const expectedTypes =
    LLAMA_FTYPE_EXPECTED_GGML_TYPES[fileType & ~LLAMA_FTYPE_GUESSED];
  if (!expectedTypes) {
    return true;
  }
  let totalElements = 0;
  for (const elements of elementsByType.values()) {
    totalElements += elements;
  }
  if (totalElements === 0) {
    return true;
  }
  const expectedElements = expectedTypes.reduce(
    (sum, typeId) => sum + (elementsByType.get(typeId) ?? 0),
    0,
  );
  return expectedElements / totalElements >= FILE_TYPE_TENSOR_SHARE_FLOOR;
}

function readQuantization(
  metadata: Map<string, GgufValue>,
  elementsByType: Map<number, number> | null,
) {
  const fileType = numberMetadata(metadata, ["general.file_type"]);
  if (fileType === null) {
    return elementsByType ? dominantTensorTypeLabel(elementsByType) : null;
  }
  const label = ggufFileTypeLabel(fileType) ?? `FileType(${fileType})`;
  if (elementsByType && !fileTypeMatchesTensors(fileType, elementsByType)) {
    return dominantTensorTypeLabel(elementsByType) ?? label;
  }
  return label;
}

export const GGUF_RAW_VERSION = 1;

export const GGUF_PARSER_VERSION = 12;

function skipFormatVersion(reader: FileReader) {
  reader.u32();
}

function readHeader(reader: FileReader) {
  if (reader.read(4).toString("utf8") !== "GGUF") {
    throw new Error("not a GGUF file");
  }
  skipFormatVersion(reader);
  const tensorCount = reader.u64Number();
  const kvCount = reader.u64Number();
  return { tensorCount, kvCount };
}

function readKv(reader: FileReader, kvCount: number) {
  const metadata = new Map<string, GgufValue>();
  for (let index = 0; index < kvCount; index += 1) {
    const key = reader.string();
    const type = reader.u32();
    metadata.set(
      key,
      readValue(
        reader,
        type,
        key.endsWith(".attention.sliding_window_pattern"),
      ),
    );
  }
  return metadata;
}

function readTensorTable(reader: FileReader, tensorCount: number) {
  let parameterCount = 0;
  let hasClassifierHead = false;
  const elementsByType = new Map<number, number>();
  for (let index = 0; index < tensorCount; index += 1) {
    const name = reader.string();
    if (
      name === "cls.weight" ||
      name.startsWith("cls.output.") ||
      name.startsWith("classifier.")
    ) {
      hasClassifierHead = true;
    }
    const dimensions = reader.u32();
    let elements = 1;
    for (let dim = 0; dim < dimensions; dim += 1) {
      elements *= reader.u64Number();
    }
    const typeId = reader.u32();
    reader.u64Number();
    parameterCount += elements;
    elementsByType.set(typeId, (elementsByType.get(typeId) ?? 0) + elements);
  }
  return { parameterCount, hasClassifierHead, elementsByType };
}

function extractMetadata(
  metadata: Map<string, GgufValue>,
  parameterCount: number | null,
  hasClassifierHead: boolean | null,
  tensorElementsByType: Map<number, number> | null,
): GgufMetadata {
  const contextLength =
    numberMetadata(metadata, [
      "llama.context_length",
      "general.context_length",
      "context_length",
    ]) ?? findNumberBySuffix(metadata, ".context_length");

  const tokens = metadata.get("tokenizer.ggml.tokens");
  const vocabularySize =
    typeof tokens === "number"
      ? tokens
      : Array.isArray(tokens)
        ? tokens.length
        : null;

  return {
    name: stringMetadata(metadata, ["general.name"]),
    architecture: stringMetadata(metadata, ["general.architecture"]),
    modelType: stringMetadata(metadata, ["general.type"]),
    poolingType: findNumberBySuffix(metadata, ".pooling_type"),
    causalAttention: findBooleanBySuffix(metadata, ".attention.causal"),
    hasClassifierHead,
    quantization: readQuantization(metadata, tensorElementsByType),
    quantizationVersion: numberMetadata(metadata, [
      "general.quantization_version",
    ]),
    sizeLabel: stringMetadata(metadata, ["general.size_label"]),
    basename: stringMetadata(metadata, ["general.basename"]),
    finetune: stringMetadata(metadata, ["general.finetune"]),
    license: stringMetadata(metadata, ["general.license"]),
    licenseLink: stringMetadata(metadata, ["general.license.link"]),
    repoUrl: stringMetadata(metadata, ["general.repo_url"]),
    version: stringMetadata(metadata, ["general.version"]),
    quantizedBy: stringMetadata(metadata, ["general.quantized_by"]),
    tags: [...new Set(stringArrayMetadata(metadata, ["general.tags"]))],
    baseModels: readBaseModels(metadata),
    parameterCount,
    contextLength,
    embeddingLength: findNumberBySuffix(metadata, ".embedding_length"),
    blockCount: findNumberBySuffix(metadata, ".block_count"),
    leadingDenseBlockCount: findNumberBySuffix(
      metadata,
      ".leading_dense_block_count",
    ),
    feedForwardLength: findNumberBySuffix(metadata, ".feed_forward_length"),
    expertCount: findNumberBySuffix(metadata, ".expert_count"),
    expertUsedCount: findNumberBySuffix(metadata, ".expert_used_count"),
    expertSharedCount: findNumberBySuffix(metadata, ".expert_shared_count"),
    expertFeedForwardLength: findNumberBySuffix(
      metadata,
      ".expert_feed_forward_length",
    ),
    headCount: findNumberBySuffix(metadata, ".attention.head_count"),
    headCountKv: findNumberBySuffix(metadata, ".attention.head_count_kv"),
    attentionKeyLength: findNumberBySuffix(metadata, ".attention.key_length"),
    attentionValueLength: findNumberBySuffix(
      metadata,
      ".attention.value_length",
    ),
    attentionKeyLengthMla: findNumberBySuffix(
      metadata,
      ".attention.key_length_mla",
    ),
    attentionValueLengthMla: findNumberBySuffix(
      metadata,
      ".attention.value_length_mla",
    ),
    slidingWindow: findNumberBySuffix(metadata, ".attention.sliding_window"),
    slidingWindowPattern: findSwaPattern(metadata),
    sharedKvLayers: findNumberBySuffix(metadata, ".attention.shared_kv_layers"),
    nextnPredictLayers: findNumberBySuffix(metadata, ".nextn_predict_layers"),
    shortConvCacheLength: findNumberBySuffix(metadata, ".shortconv.l_cache"),
    ssmConvKernel: findNumberBySuffix(metadata, ".ssm.conv_kernel"),
    ssmGroupCount: findNumberBySuffix(metadata, ".ssm.group_count"),
    ssmInnerSize: findNumberBySuffix(metadata, ".ssm.inner_size"),
    ssmStateSize: findNumberBySuffix(metadata, ".ssm.state_size"),
    wkvHeadSize: findNumberBySuffix(metadata, ".wkv.head_size"),
    tokenShiftCount: findNumberBySuffix(metadata, ".token_shift_count"),
    kdaHeadDim: findNumberBySuffix(metadata, ".kda.head_dim"),
    ropeFreqBase: findNumberBySuffix(metadata, ".rope.freq_base"),
    ropeScalingType: findStringBySuffix(metadata, ".rope.scaling.type"),
    ropeScalingFactor: findNumberBySuffix(metadata, ".rope.scaling.factor"),
    ropeScalingOrigCtxLen: findNumberBySuffix(
      metadata,
      ".rope.scaling.original_context_length",
    ),
    tokenizerModel: stringMetadata(metadata, ["tokenizer.ggml.model"]),
    tokenizerPre: stringMetadata(metadata, ["tokenizer.ggml.pre"]),
    addBosToken: findBooleanBySuffix(metadata, "tokenizer.ggml.add_bos_token"),
    addEosToken: findBooleanBySuffix(metadata, "tokenizer.ggml.add_eos_token"),
    hasChatTemplate: metadata.has("tokenizer.chat_template"),
    chatTemplateReasoning: extractChatTemplateReasoning(
      stringMetadata(metadata, ["tokenizer.chat_template"]),
    ),
    vocabularySize,
    samplingTemp: numberMetadata(metadata, ["general.sampling.temp"]),
    samplingTopK: numberMetadata(metadata, ["general.sampling.top_k"]),
    samplingTopP: numberMetadata(metadata, ["general.sampling.top_p"]),
    imatrixDataset: stringMetadata(metadata, ["quantize.imatrix.dataset"]),
    imatrixEntries: numberMetadata(metadata, [
      "quantize.imatrix.entries_count",
    ]),
    imatrixChunks: numberMetadata(metadata, ["quantize.imatrix.chunks_count"]),
  };
}

export function memoryEstimateHparams(
  metadata: GgufMetadata,
): MemoryEstimateHparams {
  return {
    architecture: metadata.architecture,
    blockCount: metadata.blockCount,
    embeddingLength: metadata.embeddingLength,
    headCount: metadata.headCount,
    headCountKv: metadata.headCountKv,
    attentionKeyLength: metadata.attentionKeyLength,
    attentionValueLength: metadata.attentionValueLength,
    attentionKeyLengthMla: metadata.attentionKeyLengthMla,
    attentionValueLengthMla: metadata.attentionValueLengthMla,
    causalAttention: metadata.causalAttention,
    contextLength: metadata.contextLength,
    slidingWindow: metadata.slidingWindow,
    slidingWindowPattern: metadata.slidingWindowPattern,
    sharedKvLayers: metadata.sharedKvLayers,
    nextnPredictLayers: metadata.nextnPredictLayers,
    shortConvCacheLength: metadata.shortConvCacheLength,
    ssmConvKernel: metadata.ssmConvKernel,
    ssmGroupCount: metadata.ssmGroupCount,
    ssmInnerSize: metadata.ssmInnerSize,
    ssmStateSize: metadata.ssmStateSize,
    wkvHeadSize: metadata.wkvHeadSize,
    tokenShiftCount: metadata.tokenShiftCount,
    kdaHeadDim: metadata.kdaHeadDim,
    vocabularySize: metadata.vocabularySize,
  };
}

export function readGgufFacts(path: string): GgufRawFacts {
  const fd = openSync(path, "r");
  try {
    const reader = new FileReader(fd);
    const { tensorCount, kvCount } = readHeader(reader);
    const metadata = readKv(reader, kvCount);
    let tensors: GgufRawFacts["tensors"] = null;
    try {
      const table = readTensorTable(reader, tensorCount);
      tensors = {
        parameterCount: table.parameterCount,
        hasClassifierHead: table.hasClassifierHead,
        elementsByType: [...table.elementsByType.entries()],
      };
    } catch (error) {
      logger.warn({ err: error, path }, "GGUF tensor table could not be read");
    }
    return { kv: [...metadata.entries()], tensors };
  } finally {
    closeSync(fd);
  }
}

export function deriveGgufMetadata(facts: GgufRawFacts): GgufMetadata {
  return extractMetadata(
    new Map(facts.kv),
    facts.tensors?.parameterCount ?? null,
    facts.tensors?.hasClassifierHead ?? null,
    facts.tensors ? new Map(facts.tensors.elementsByType) : null,
  );
}

export function readGgufMetadata(path: string): GgufMetadata {
  return deriveGgufMetadata(readGgufFacts(path));
}

export function readGgufParameterCount(path: string): number {
  const fd = openSync(path, "r");
  try {
    const reader = new FileReader(fd);
    const { tensorCount, kvCount } = readHeader(reader);
    readKv(reader, kvCount);
    return readTensorTable(reader, tensorCount).parameterCount;
  } finally {
    closeSync(fd);
  }
}

function readTensorInfos(
  reader: FileReader,
  tensorCount: number,
): GgufTensorInfo[] {
  const tensors: GgufTensorInfo[] = [];
  for (let index = 0; index < tensorCount; index += 1) {
    const name = reader.string();
    const dimensions = reader.u32();
    const dims: number[] = [];
    for (let dim = 0; dim < dimensions; dim += 1) {
      dims.push(reader.u64Number());
    }
    const typeId = reader.u32();
    reader.u64Number();
    const elements = dims.reduce((product, dim) => product * dim, 1);
    const bytes = ggmlTensorBytes(typeId, dims);
    tensors.push({
      name,
      typeId,
      type: ggmlTypeName(typeId) ?? `type${typeId}`,
      dims,
      elements,
      bytes: bytes ?? 0,
    });
  }
  return tensors;
}

export function readGgufTensorTable(path: string): GgufTensorTable {
  const fd = openSync(path, "r");
  try {
    const reader = new FileReader(fd);
    const { tensorCount, kvCount } = readHeader(reader);
    readKv(reader, kvCount);
    const tensors = readTensorInfos(reader, tensorCount);
    const unknownTypeIds = [
      ...new Set(
        tensors
          .filter((tensor) => ggmlTypeName(tensor.typeId) === null)
          .map((tensor) => tensor.typeId),
      ),
    ].sort((left, right) => left - right);
    return {
      path,
      tensorCount,
      totalBytes: tensors.reduce((sum, tensor) => sum + tensor.bytes, 0),
      unknownTypeIds,
      tensors,
    };
  } finally {
    closeSync(fd);
  }
}

export type GgufFileIdentity = { sizeBytes: number; modifiedAt: string };

export function ggufFileIdentityFromStats(
  stats: Array<{ size: number; mtime: Date }>,
): GgufFileIdentity {
  return {
    sizeBytes: stats.reduce((sum, item) => sum + item.size, 0),
    modifiedAt: new Date(
      Math.max(...stats.map((item) => item.mtime.getTime())),
    ).toISOString(),
  };
}

export async function ggufFileIdentity(
  modelPath: string,
): Promise<GgufFileIdentity> {
  const stats = await Promise.all(
    resolveGgufShardPaths(modelPath).map((shard) => stat(shard)),
  );
  return ggufFileIdentityFromStats(stats);
}

export function resolveGgufShardPaths(modelPath: string): string[] {
  const split = parseSplitInfo(basename(modelPath));
  if (!split) {
    return [modelPath];
  }
  const directory = dirname(modelPath);
  const shards: string[] = [];
  for (let index = 1; index <= split.count; index += 1) {
    const shardPath = join(
      directory,
      splitShardName(split, index, split.count),
    );
    if (existsSync(shardPath)) {
      shards.push(shardPath);
    }
  }
  return shards.length > 0 ? shards : [modelPath];
}

export function readGgufModelTensorTable(modelPath: string): GgufTensorTable {
  const shards = resolveGgufShardPaths(modelPath);
  if (shards.length <= 1) {
    return readGgufTensorTable(modelPath);
  }
  const tables = shards.map((shardPath) => readGgufTensorTable(shardPath));
  const unknownTypeIds = [
    ...new Set(tables.flatMap((table) => table.unknownTypeIds)),
  ].sort((left, right) => left - right);
  return {
    path: modelPath,
    tensorCount: tables.reduce((sum, table) => sum + table.tensorCount, 0),
    totalBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    unknownTypeIds,
    tensors: tables.flatMap((table) => table.tensors),
  };
}
