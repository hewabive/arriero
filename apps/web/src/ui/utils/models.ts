import {
  stripGgufSuffix,
  type GgufModel,
  type SafetensorsModel,
} from "@arriero/core";

export function formatBytes(bytes: number, digits?: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(digits ?? (unitIndex === 0 ? 0 : 1))} ${units[unitIndex]}`;
}

export function formatBytesPerSecond(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }
  return `${formatBytes(value)}/s`;
}

function displayNameFromFileName(name: string) {
  return stripGgufSuffix(name);
}

export function modelTitle(model: GgufModel) {
  return displayNameFromFileName(model.name);
}

export function formatParameterCount(count: number | null) {
  if (count === null || count <= 0) {
    return null;
  }
  if (count >= 1e12) {
    return `${(count / 1e12).toFixed(2)}T`;
  }
  if (count >= 1e9) {
    return `${(count / 1e9).toFixed(count >= 1e11 ? 0 : 1)}B`;
  }
  if (count >= 1e6) {
    return `${(count / 1e6).toFixed(0)}M`;
  }
  return count.toLocaleString();
}

export function bitsPerWeight(model: GgufModel) {
  const params = model.metadata.parameterCount;
  if (params === null || params <= 0) {
    return null;
  }
  return (model.sizeBytes * 8) / params;
}

export type ModelLayerInfo = {
  isMoe: boolean;
  total: number | null;
  dense: number | null;
  moe: number | null;
};

export function modelLayerInfo(model: GgufModel): ModelLayerInfo {
  const { blockCount, leadingDenseBlockCount, expertCount } = model.metadata;
  const isMoe = expertCount !== null && expertCount > 1;
  if (!isMoe) {
    return { isMoe: false, total: blockCount, dense: blockCount, moe: 0 };
  }
  if (blockCount === null) {
    return { isMoe: true, total: null, dense: null, moe: null };
  }
  const dense = leadingDenseBlockCount ?? 0;
  return { isMoe: true, total: blockCount, dense, moe: blockCount - dense };
}

function compareTitleText(left: string, right: string) {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function compareModelTitles(left: GgufModel, right: GgufModel) {
  return (
    compareTitleText(modelTitle(left), modelTitle(right)) ||
    compareTitleText(left.name, right.name) ||
    compareTitleText(left.path, right.path)
  );
}

export function pathBaseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function instanceNameFromModelPath(path: string) {
  return (
    stripGgufSuffix(pathBaseName(path))
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "local-server"
  );
}

export function isVocabModel(model: GgufModel) {
  const haystack =
    `${model.name} ${model.path} ${model.metadata.name ?? ""}`.toLowerCase();
  return (
    haystack.includes("ggml-vocab") || haystack.includes("/models/ggml-vocab")
  );
}

function fieldsMatchSearch(
  values: Array<string | number | null>,
  query: string,
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return values
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

export function safetensorsMatchesSearch(
  model: SafetensorsModel,
  query: string,
) {
  return fieldsMatchSearch(
    [
      model.name,
      model.path,
      model.metadata.architecture,
      model.metadata.modelType,
      model.metadata.quantization,
      model.metadata.dominantDtype,
      model.metadata.kind,
      model.metadata.mtpParameterCount ? "mtp" : null,
      model.metadata.visionParameterCount ? "vision" : null,
    ],
    query,
  );
}

export function compareSafetensorsTitles(
  left: SafetensorsModel,
  right: SafetensorsModel,
) {
  return (
    compareTitleText(left.name, right.name) ||
    compareTitleText(left.path, right.path)
  );
}

export function modelMatchesSearch(model: GgufModel, query: string) {
  return fieldsMatchSearch(
    [
      model.name,
      model.path,
      model.metadata.name,
      model.metadata.architecture,
      model.metadata.quantization,
      model.metadata.sizeLabel,
      model.metadata.basename,
      model.metadata.nextnPredictLayers ? "mtp" : null,
    ],
    query,
  );
}

function formatSampler(value: number) {
  return String(Math.round(value * 1000) / 1000);
}

export function samplingSummary(metadata: {
  samplingTemp: number | null;
  samplingTopK: number | null;
  samplingTopP: number | null;
}) {
  const summary = [
    metadata.samplingTemp !== null
      ? `temp ${formatSampler(metadata.samplingTemp)}`
      : null,
    metadata.samplingTopK !== null ? `top_k ${metadata.samplingTopK}` : null,
    metadata.samplingTopP !== null
      ? `top_p ${formatSampler(metadata.samplingTopP)}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return summary || null;
}

export function ropeScalingLabel(metadata: {
  ropeScalingType: string | null;
  ropeScalingFactor: number | null;
}) {
  if (!metadata.ropeScalingType) {
    return null;
  }
  return `${metadata.ropeScalingType}${
    metadata.ropeScalingFactor ? ` ×${metadata.ropeScalingFactor}` : ""
  }`;
}
