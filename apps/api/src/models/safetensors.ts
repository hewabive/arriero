import type {
  GgufChatTemplateReasoning,
  SafetensorsKind,
  SafetensorsMetadata,
} from "@arriero/core";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { extractChatTemplateReasoning } from "./chat-template-reasoning.js";
import {
  fileIdentityFromStats,
  type ModelFileIdentity,
} from "./file-identity.js";

export const SAFETENSORS_RAW_VERSION = 2;

export const SAFETENSORS_PARSER_VERSION = 2;

const SAFETENSORS_INDEX_FILE = "model.safetensors.index.json";

const SIDECAR_FILES = [
  "config.json",
  "adapter_config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "chat_template.jinja",
  "chat_template.json",
  SAFETENSORS_INDEX_FILE,
];

const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const CONFIG_VALUE_CAPTURE_LIMIT = 16_384;

type JsonObject = Record<string, unknown>;

type SafetensorsTensorGroup = {
  suffix: string;
  dtype: string;
  tensorCount: number;
  elements: number;
};

type SafetensorsPackedShapeFacts = {
  tensorCount: number;
  elements: number;
};

type SafetensorsTensorFacts = {
  tensorCount: number;
  groups: SafetensorsTensorGroup[];
  packedShape: SafetensorsPackedShapeFacts | null;
};

export type SafetensorsRawFacts = {
  config: JsonObject | null;
  adapterConfig: JsonObject | null;
  generationConfig: JsonObject | null;
  chatTemplate: string | null;
  indexFiles: string[] | null;
  indexTotalSizeBytes: number | null;
  weightFiles: string[];
  tensors: SafetensorsTensorFacts | null;
};

export type SafetensorsReadResult = {
  facts: SafetensorsRawFacts;
  errors: string[];
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafetensorsWeightName(name: string) {
  return name.toLowerCase().endsWith(".safetensors");
}

export function listSafetensorsWeightNames(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSafetensorsWeightName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function safetensorsDirIdentity(
  directory: string,
  weightPaths: string[],
): Promise<ModelFileIdentity> {
  const stats = await Promise.all(weightPaths.map((path) => stat(path)));
  for (const sidecar of SIDECAR_FILES) {
    try {
      stats.push(await stat(join(directory, sidecar)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return fileIdentityFromStats(stats);
}

function readExact(
  fd: number,
  buffer: Buffer,
  length: number,
  position: number,
) {
  let filled = 0;
  while (filled < length) {
    const bytesRead = readSync(
      fd,
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      throw new Error("unexpected end of safetensors file");
    }
    filled += bytesRead;
  }
}

const QUANT_STATE_SEGMENT = ".quant_state.";
const PACKED_SHAPE_SUFFIX = "weight_shape";
const MAX_PACKED_SHAPE_DIMS = 8;

function tensorSuffix(name: string): string {
  if (name.includes(QUANT_STATE_SEGMENT)) {
    return "quant_state";
  }
  const separator = name.lastIndexOf(".");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function groupKey(suffix: string, dtype: string): string {
  return `${suffix}\0${dtype}`;
}

function mergeGroup(
  groups: Map<string, SafetensorsTensorGroup>,
  suffix: string,
  dtype: string,
  tensorCount: number,
  elements: number,
) {
  const key = groupKey(suffix, dtype);
  const group = groups.get(key) ?? {
    suffix,
    dtype,
    tensorCount: 0,
    elements: 0,
  };
  group.tensorCount += tensorCount;
  group.elements += elements;
  groups.set(key, group);
}

function mergePackedShape(
  total: SafetensorsPackedShapeFacts | null,
  addition: SafetensorsPackedShapeFacts | null,
): SafetensorsPackedShapeFacts | null {
  if (!addition) {
    return total;
  }
  return {
    tensorCount: (total?.tensorCount ?? 0) + addition.tensorCount,
    elements: (total?.elements ?? 0) + addition.elements,
  };
}

function readPackedShapeElements(
  fd: number,
  dataStart: number,
  dtype: string,
  dims: number,
  offsets: unknown,
): number | null {
  if (
    dtype !== "I64" ||
    dims < 1 ||
    dims > MAX_PACKED_SHAPE_DIMS ||
    !Array.isArray(offsets)
  ) {
    return null;
  }
  const [start, end] = offsets;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    end - start !== dims * 8
  ) {
    return null;
  }
  const buffer = Buffer.alloc(dims * 8);
  try {
    readExact(fd, buffer, buffer.length, dataStart + start);
  } catch {
    return null;
  }
  let elements = 1;
  for (let index = 0; index < dims; index += 1) {
    const dim = Number(buffer.readBigInt64LE(index * 8));
    if (!Number.isSafeInteger(dim) || dim <= 0) {
      return null;
    }
    elements *= dim;
  }
  return elements;
}

export function readSafetensorsHeader(path: string): SafetensorsTensorFacts {
  const fd = openSync(path, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    readExact(fd, lengthBuffer, 8, 0);
    const headerLength = lengthBuffer.readBigUInt64LE(0);
    if (headerLength <= 0n || headerLength > BigInt(MAX_HEADER_BYTES)) {
      throw new Error(
        `unexpected safetensors header length: ${headerLength.toString()}`,
      );
    }
    const headerBuffer = Buffer.alloc(Number(headerLength));
    readExact(fd, headerBuffer, Number(headerLength), 8);
    const header: unknown = JSON.parse(headerBuffer.toString("utf8"));
    if (!isJsonObject(header)) {
      throw new Error("safetensors header is not a JSON object");
    }

    const dataStart = 8 + Number(headerLength);
    let tensorCount = 0;
    const groups = new Map<string, SafetensorsTensorGroup>();
    let packedShape: SafetensorsPackedShapeFacts | null = null;
    for (const [name, info] of Object.entries(header)) {
      if (name === "__metadata__" || !isJsonObject(info)) {
        continue;
      }
      const dtype = typeof info.dtype === "string" ? info.dtype : "unknown";
      let elements = 0;
      if (Array.isArray(info.shape)) {
        elements = 1;
        for (const dim of info.shape) {
          if (typeof dim !== "number") {
            elements = 0;
            break;
          }
          elements *= dim;
        }
      }
      tensorCount += 1;
      const suffix = tensorSuffix(name);
      mergeGroup(groups, suffix, dtype, 1, elements);
      if (suffix === PACKED_SHAPE_SUFFIX) {
        const unpacked = readPackedShapeElements(
          fd,
          dataStart,
          dtype,
          elements,
          info.data_offsets,
        );
        if (unpacked !== null) {
          packedShape = mergePackedShape(packedShape, {
            tensorCount: 1,
            elements: unpacked,
          });
        }
      }
    }
    return { tensorCount, groups: [...groups.values()], packedShape };
  } finally {
    closeSync(fd);
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readJsonObjectFile(
  directory: string,
  name: string,
  errors: string[],
): JsonObject | null {
  let text: string | null;
  try {
    text = readTextFile(join(directory, name));
  } catch (error) {
    errors.push(`${name}: ${(error as Error).message}`);
    return null;
  }
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed;
  } catch (error) {
    errors.push(`${name}: ${(error as Error).message}`);
    return null;
  }
}

const QUANTIZATION_CONFIG_KEY = "quantization_config";
const QUANTIZATION_CONFIG_BULK_KEYS = new Set([
  "ignore",
  "modules_to_not_convert",
  "llm_int8_skip_modules",
]);

function trimmedQuantizationConfig(value: JsonObject): JsonObject {
  const trimmed: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!QUANTIZATION_CONFIG_BULK_KEYS.has(key)) {
      trimmed[key] = entry;
    }
  }
  return trimmed;
}

function captureJsonObject(value: JsonObject): JsonObject {
  const captured: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const serialized = JSON.stringify(entry);
    if (serialized === undefined) {
      continue;
    }
    if (serialized.length <= CONFIG_VALUE_CAPTURE_LIMIT) {
      captured[key] = entry;
      continue;
    }
    if (key === QUANTIZATION_CONFIG_KEY && isJsonObject(entry)) {
      const trimmed = trimmedQuantizationConfig(entry);
      const trimmedSerialized = JSON.stringify(trimmed);
      if (
        trimmedSerialized !== undefined &&
        trimmedSerialized.length <= CONFIG_VALUE_CAPTURE_LIMIT
      ) {
        captured[key] = trimmed;
      }
    }
  }
  return captured;
}

function chatTemplateFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  let fallback: string | null = null;
  for (const item of value) {
    if (!isJsonObject(item) || typeof item.template !== "string") {
      continue;
    }
    if (item.name === "default") {
      return item.template;
    }
    fallback = fallback ?? item.template;
  }
  return fallback;
}

function readChatTemplate(directory: string, errors: string[]): string | null {
  let jinja: string | null = null;
  try {
    jinja = readTextFile(join(directory, "chat_template.jinja"));
  } catch (error) {
    errors.push(`chat_template.jinja: ${(error as Error).message}`);
  }
  if (jinja !== null) {
    return jinja;
  }
  const tokenizerConfig = readJsonObjectFile(
    directory,
    "tokenizer_config.json",
    errors,
  );
  const fromTokenizer = chatTemplateFromValue(tokenizerConfig?.chat_template);
  if (fromTokenizer !== null) {
    return fromTokenizer;
  }
  const chatTemplateJson = readJsonObjectFile(
    directory,
    "chat_template.json",
    errors,
  );
  return chatTemplateFromValue(chatTemplateJson?.chat_template);
}

function readIndex(
  directory: string,
  errors: string[],
): { files: string[] | null; totalSizeBytes: number | null } {
  const index = readJsonObjectFile(directory, SAFETENSORS_INDEX_FILE, errors);
  if (!index) {
    return { files: null, totalSizeBytes: null };
  }
  const files = isJsonObject(index.weight_map)
    ? [
        ...new Set(
          Object.values(index.weight_map).filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      ].sort()
    : null;
  const totalSize = isJsonObject(index.metadata)
    ? index.metadata.total_size
    : null;
  return {
    files,
    totalSizeBytes: typeof totalSize === "number" ? totalSize : null,
  };
}

export function readSafetensorsFacts(directory: string): SafetensorsReadResult {
  const errors: string[] = [];
  const presentWeights = listSafetensorsWeightNames(directory);
  const present = new Set(presentWeights);
  const index = readIndex(directory, errors);
  const weightFiles = index.files
    ? index.files.filter((name) => present.has(name))
    : presentWeights;

  let tensorCount = 0;
  const groups = new Map<string, SafetensorsTensorGroup>();
  let packedShape: SafetensorsPackedShapeFacts | null = null;
  let headerFailed = false;
  for (const name of weightFiles) {
    try {
      const summary = readSafetensorsHeader(join(directory, name));
      tensorCount += summary.tensorCount;
      for (const group of summary.groups) {
        mergeGroup(
          groups,
          group.suffix,
          group.dtype,
          group.tensorCount,
          group.elements,
        );
      }
      packedShape = mergePackedShape(packedShape, summary.packedShape);
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      headerFailed = true;
    }
  }

  const config = readJsonObjectFile(directory, "config.json", errors);
  const adapterConfig = readJsonObjectFile(
    directory,
    "adapter_config.json",
    errors,
  );
  const generationConfig = readJsonObjectFile(
    directory,
    "generation_config.json",
    errors,
  );

  return {
    facts: {
      config: config ? captureJsonObject(config) : null,
      adapterConfig: adapterConfig ? captureJsonObject(adapterConfig) : null,
      generationConfig: generationConfig
        ? captureJsonObject(generationConfig)
        : null,
      chatTemplate: readChatTemplate(directory, errors),
      indexFiles: index.files,
      indexTotalSizeBytes: index.totalSizeBytes,
      weightFiles,
      tensors:
        headerFailed || weightFiles.length === 0
          ? null
          : {
              tensorCount,
              groups: [...groups.values()],
              packedShape,
            },
    },
    errors,
  };
}

function pickNumber(source: JsonObject | null, keys: string[]): number | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pickString(source: JsonObject | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function pickBoolean(
  source: JsonObject | null,
  keys: string[],
): boolean | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

type QuantizationScheme = {
  method: string | null;
  bits: number | null;
  floatWeights: boolean;
  bnb4BitType: string | null;
  label: string | null;
};

function compressedTensorsGroupWeights(raw: JsonObject): JsonObject | null {
  const configGroups = raw.config_groups;
  if (!isJsonObject(configGroups)) {
    return null;
  }
  let weights: JsonObject | null = null;
  let bits: number | null = null;
  for (const group of Object.values(configGroups)) {
    if (!isJsonObject(group) || !isJsonObject(group.weights)) {
      continue;
    }
    const groupBits = pickNumber(group.weights, ["num_bits"]);
    if (weights === null) {
      weights = group.weights;
      bits = groupBits;
    } else if (groupBits !== bits) {
      return null;
    }
  }
  return weights;
}

function quantizationScheme(config: JsonObject | null): QuantizationScheme {
  const raw = config?.quantization_config;
  if (!isJsonObject(raw)) {
    return {
      method: null,
      bits: null,
      floatWeights: false,
      bnb4BitType: null,
      label: null,
    };
  }
  const groupWeights = compressedTensorsGroupWeights(raw);
  const method =
    pickString(raw, ["quant_method"]) ??
    (raw.load_in_4bit === true || raw.load_in_8bit === true
      ? "bitsandbytes"
      : null);
  const bits =
    pickNumber(raw, ["bits", "w_bit", "weight_bits", "num_bits"]) ??
    pickNumber(groupWeights, ["num_bits"]) ??
    (raw.load_in_4bit === true ? 4 : raw.load_in_8bit === true ? 8 : null);
  const floatWeights =
    pickString(groupWeights, ["type"]) === "float" || method === "mxfp4";
  const label = method
    ? `${method}${bits !== null ? ` ${bits}-bit` : ""}`
    : bits !== null
      ? `${bits}-bit`
      : "quantized";
  return {
    method,
    bits,
    floatWeights,
    bnb4BitType: pickString(raw, ["bnb_4bit_quant_type"]),
    label,
  };
}

const QUANTIZATION_OVERHEAD_SUFFIXES = new Set([
  "scales",
  "zeros",
  "qzeros",
  "g_idx",
  "quant_state",
  "absmax",
  "nested_absmax",
  "quant_map",
  "nested_quant_map",
  "SCB",
  "weight_format",
  "weight_scale",
  "weight_zero_point",
  "weight_shape",
  "weight_g_idx",
  "weight_scale_inv",
  "weight_global_scale",
  "input_scale",
  "input_zero_point",
  "input_global_scale",
  "output_scale",
  "output_zero_point",
  "k_scale",
  "v_scale",
  "q_scale",
  "prob_scale",
]);

const PACKED_WEIGHT_SUFFIXES = new Set(["weight_packed", "qweight"]);

const CONTAINER_BITS: Record<string, number> = {
  I8: 8,
  U8: 8,
  I16: 16,
  U16: 16,
  I32: 32,
  U32: 32,
  I64: 64,
  U64: 64,
};

function packFactorFromBits(dtype: string, bits: number | null): number | null {
  if (bits === null || bits <= 0) {
    return null;
  }
  const container = CONTAINER_BITS[dtype];
  if (container === undefined || container % bits !== 0) {
    return null;
  }
  return container / bits;
}

function suffixElements(
  groups: SafetensorsTensorGroup[],
  suffix: string,
): number {
  let total = 0;
  for (const group of groups) {
    if (group.suffix === suffix) {
      total += group.elements;
    }
  }
  return total;
}

function inferredPackFactor(
  dtype: string,
  scalesElements: number,
  zerosElements: number,
): number | null {
  const container = CONTAINER_BITS[dtype];
  if (container === undefined || scalesElements <= 0 || zerosElements <= 0) {
    return null;
  }
  const factor = scalesElements / zerosElements;
  if (!Number.isInteger(factor) || factor < 2 || container % factor !== 0) {
    return null;
  }
  return factor;
}

function isBnb4BitWeight(
  group: SafetensorsTensorGroup,
  scheme: QuantizationScheme,
): boolean {
  return (
    scheme.method === "bitsandbytes" &&
    scheme.bits === 4 &&
    group.suffix === "weight" &&
    group.dtype === "U8"
  );
}

type SafetensorsTensorStats = {
  parameterCount: number | null;
  elementsByDtype: Array<[string, number]>;
};

function deriveTensorStats(
  tensors: SafetensorsTensorFacts | null,
  scheme: QuantizationScheme,
): SafetensorsTensorStats {
  if (!tensors) {
    return { parameterCount: null, elementsByDtype: [] };
  }
  const byLabel = new Map<string, number>();
  const add = (label: string, elements: number) => {
    byLabel.set(label, (byLabel.get(label) ?? 0) + elements);
  };
  const finish = (unresolved: boolean): SafetensorsTensorStats => {
    const elementsByDtype = [...byLabel.entries()].sort(
      (left, right) => right[1] - left[1],
    );
    let total = 0;
    for (const [, elements] of elementsByDtype) {
      total += elements;
    }
    return { parameterCount: unresolved ? null : total, elementsByDtype };
  };

  const quantized =
    scheme.method !== null ||
    tensors.groups.some((group) => PACKED_WEIGHT_SUFFIXES.has(group.suffix));
  if (!quantized) {
    for (const group of tensors.groups) {
      add(group.dtype, group.elements);
    }
    return finish(false);
  }

  const packedLabel =
    scheme.bits !== null
      ? `${scheme.floatWeights ? "fp" : "int"}${scheme.bits}`
      : "packed";
  const packedTensorTotal = tensors.groups.reduce(
    (total, group) =>
      group.suffix === "weight_packed" ? total + group.tensorCount : total,
    0,
  );
  const packedShapeUsable =
    tensors.packedShape !== null &&
    packedTensorTotal > 0 &&
    tensors.packedShape.tensorCount === packedTensorTotal;
  const scalesElements = suffixElements(tensors.groups, "scales");
  const qzerosElements = suffixElements(tensors.groups, "qzeros");

  let unresolved = false;
  for (const group of tensors.groups) {
    if (QUANTIZATION_OVERHEAD_SUFFIXES.has(group.suffix)) {
      continue;
    }
    if (scheme.method === "mxfp4" && group.suffix.endsWith("scales")) {
      continue;
    }
    if (scheme.method === "mxfp4" && group.suffix.endsWith("blocks")) {
      add("fp4", group.elements * 2);
      continue;
    }
    if (group.suffix === "weight_packed") {
      if (packedShapeUsable) {
        continue;
      }
      const factor = packFactorFromBits(group.dtype, scheme.bits);
      if (factor === null) {
        unresolved = true;
        add(group.dtype, group.elements);
      } else {
        add(packedLabel, group.elements * factor);
      }
      continue;
    }
    if (group.suffix === "qweight") {
      const factor =
        packFactorFromBits(group.dtype, scheme.bits) ??
        inferredPackFactor(group.dtype, scalesElements, qzerosElements);
      if (factor === null) {
        unresolved = true;
        add(group.dtype, group.elements);
        continue;
      }
      const container = CONTAINER_BITS[group.dtype];
      const label =
        scheme.bits !== null
          ? packedLabel
          : container !== undefined
            ? `int${container / factor}`
            : "packed";
      add(label, group.elements * factor);
      continue;
    }
    if (isBnb4BitWeight(group, scheme)) {
      add(scheme.bnb4BitType ?? "int4", group.elements * 2);
      continue;
    }
    add(group.dtype, group.elements);
  }
  if (packedShapeUsable && tensors.packedShape) {
    add(packedLabel, tensors.packedShape.elements);
  }
  return finish(unresolved);
}

function dominantDtypeLabel(
  elementsByDtype: Array<[string, number]>,
): string | null {
  let dominant: [string, number] | null = null;
  for (const entry of elementsByDtype) {
    if (!dominant || entry[1] > dominant[1]) {
      dominant = entry;
    }
  }
  return dominant ? dominant[0] : null;
}

function architectureFromConfig(config: JsonObject | null): string | null {
  const architectures = config?.architectures;
  if (!Array.isArray(architectures)) {
    return null;
  }
  const first = architectures.find(
    (value): value is string => typeof value === "string",
  );
  return first ?? null;
}

export function deriveSafetensorsMetadata(
  facts: SafetensorsRawFacts,
): SafetensorsMetadata {
  const config = facts.config;
  const textConfig = isJsonObject(config?.text_config)
    ? config.text_config
    : null;
  const num = (keys: string[]) =>
    pickNumber(config, keys) ?? pickNumber(textConfig, keys);
  const str = (keys: string[]) =>
    pickString(config, keys) ?? pickString(textConfig, keys);
  const bool = (keys: string[]) =>
    pickBoolean(config, keys) ?? pickBoolean(textConfig, keys);

  const kind: SafetensorsKind = config
    ? "model"
    : facts.adapterConfig
      ? "adapter"
      : "weights";

  const quantization = quantizationScheme(config);
  const stats = deriveTensorStats(facts.tensors, quantization);
  const elementsByDtype = stats.elementsByDtype;
  const dominantDtype = dominantDtypeLabel(elementsByDtype);

  const ropeScalingRaw = config?.rope_scaling ?? textConfig?.rope_scaling;
  const ropeScaling = isJsonObject(ropeScalingRaw) ? ropeScalingRaw : null;

  const missingShards = safetensorsMissingShardNames(facts);

  const chatTemplateReasoning: GgufChatTemplateReasoning | null =
    extractChatTemplateReasoning(facts.chatTemplate);

  return {
    kind,
    architecture:
      architectureFromConfig(config) ?? architectureFromConfig(textConfig),
    modelType: str(["model_type"]),
    baseModel: pickString(facts.adapterConfig, ["base_model_name_or_path"]),
    torchDtype: str(["torch_dtype", "dtype"]),
    dominantDtype,
    elementsByDtype,
    quantization: quantization.label ?? dominantDtype,
    quantizationMethod: quantization.method,
    parameterCount:
      facts.tensors && missingShards.length === 0 ? stats.parameterCount : null,
    tensorCount: facts.tensors?.tensorCount ?? null,
    contextLength: num(["max_position_embeddings"]),
    embeddingLength: num(["hidden_size"]),
    blockCount: num(["num_hidden_layers"]),
    feedForwardLength: num(["intermediate_size"]),
    headCount: num(["num_attention_heads"]),
    headCountKv: num(["num_key_value_heads"]),
    headDim: num(["head_dim"]),
    expertCount: num(["num_experts", "num_local_experts", "n_routed_experts"]),
    expertUsedCount: num(["num_experts_per_tok"]),
    expertSharedCount: num(["n_shared_experts", "num_shared_experts"]),
    expertFeedForwardLength: num(["moe_intermediate_size"]),
    slidingWindow: num(["sliding_window"]),
    vocabularySize: num(["vocab_size"]),
    tieWordEmbeddings: bool(["tie_word_embeddings"]),
    ropeFreqBase: num(["rope_theta"]),
    ropeScalingType: pickString(ropeScaling, ["rope_type", "type"]),
    ropeScalingFactor: pickNumber(ropeScaling, ["factor"]),
    ropeScalingOrigCtxLen: pickNumber(ropeScaling, [
      "original_max_position_embeddings",
    ]),
    hasChatTemplate: facts.chatTemplate !== null,
    chatTemplateReasoning,
    samplingTemp: pickNumber(facts.generationConfig, ["temperature"]),
    samplingTopK: pickNumber(facts.generationConfig, ["top_k"]),
    samplingTopP: pickNumber(facts.generationConfig, ["top_p"]),
    transformersVersion: pickString(config, ["transformers_version"]),
  };
}

export function emptySafetensorsFacts(): SafetensorsRawFacts {
  return {
    config: null,
    adapterConfig: null,
    generationConfig: null,
    chatTemplate: null,
    indexFiles: null,
    indexTotalSizeBytes: null,
    weightFiles: [],
    tensors: null,
  };
}

export function safetensorsMissingShardNames(
  facts: Pick<SafetensorsRawFacts, "indexFiles" | "weightFiles">,
): string[] {
  if (facts.indexFiles === null) {
    return [];
  }
  const present = new Set(facts.weightFiles);
  return facts.indexFiles.filter((name) => !present.has(name));
}
