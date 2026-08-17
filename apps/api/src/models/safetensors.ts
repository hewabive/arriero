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

export const SAFETENSORS_RAW_VERSION = 1;

export const SAFETENSORS_PARSER_VERSION = 1;

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

type SafetensorsTensorFacts = {
  tensorCount: number;
  parameterCount: number;
  elementsByDtype: Array<[string, number]>;
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

type SafetensorsHeaderSummary = {
  tensorCount: number;
  parameterCount: number;
  elementsByDtype: Map<string, number>;
};

export function readSafetensorsHeader(path: string): SafetensorsHeaderSummary {
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

    let tensorCount = 0;
    let parameterCount = 0;
    const elementsByDtype = new Map<string, number>();
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
      parameterCount += elements;
      elementsByDtype.set(dtype, (elementsByDtype.get(dtype) ?? 0) + elements);
    }
    return { tensorCount, parameterCount, elementsByDtype };
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

function captureJsonObject(value: JsonObject): JsonObject {
  const captured: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const serialized = JSON.stringify(entry);
    if (
      serialized !== undefined &&
      serialized.length <= CONFIG_VALUE_CAPTURE_LIMIT
    ) {
      captured[key] = entry;
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
  let parameterCount = 0;
  const elementsByDtype = new Map<string, number>();
  let headerFailed = false;
  for (const name of weightFiles) {
    try {
      const summary = readSafetensorsHeader(join(directory, name));
      tensorCount += summary.tensorCount;
      parameterCount += summary.parameterCount;
      for (const [dtype, elements] of summary.elementsByDtype) {
        elementsByDtype.set(
          dtype,
          (elementsByDtype.get(dtype) ?? 0) + elements,
        );
      }
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
              parameterCount,
              elementsByDtype: [...elementsByDtype.entries()],
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

function quantizationInfo(config: JsonObject | null): {
  method: string | null;
  label: string | null;
} {
  const raw = config?.quantization_config;
  if (!isJsonObject(raw)) {
    return { method: null, label: null };
  }
  const method =
    pickString(raw, ["quant_method"]) ??
    (raw.load_in_4bit === true || raw.load_in_8bit === true
      ? "bitsandbytes"
      : null);
  const bits =
    pickNumber(raw, ["bits", "w_bit", "weight_bits", "num_bits"]) ??
    (raw.load_in_4bit === true ? 4 : raw.load_in_8bit === true ? 8 : null);
  const label = method
    ? `${method}${bits !== null ? ` ${bits}-bit` : ""}`
    : bits !== null
      ? `${bits}-bit`
      : "quantized";
  return { method, label };
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

  const quantization = quantizationInfo(config);
  const elementsByDtype = facts.tensors?.elementsByDtype ?? [];
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
      facts.tensors && missingShards.length === 0
        ? facts.tensors.parameterCount
        : null,
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
