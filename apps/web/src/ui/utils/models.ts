import {
  stripGgufSuffix,
  type GgufModel,
  type SafetensorsModel,
} from "@arriero/core";

export function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function displayNameFromFileName(name: string) {
  return stripGgufSuffix(name.replace(/-\d+-of-\d+\.gguf$/i, ""));
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

export function compareModelTitles(left: GgufModel, right: GgufModel) {
  return (
    modelTitle(left).localeCompare(modelTitle(right), undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    })
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

export function safetensorsMatchesSearch(
  model: SafetensorsModel,
  query: string,
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    model.name,
    model.path,
    model.metadata.architecture,
    model.metadata.modelType,
    model.metadata.quantization,
    model.metadata.dominantDtype,
    model.metadata.kind,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

export function compareSafetensorsTitles(
  left: SafetensorsModel,
  right: SafetensorsModel,
) {
  return (
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

export function modelMatchesSearch(model: GgufModel, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    model.name,
    model.path,
    model.metadata.name,
    model.metadata.architecture,
    model.metadata.quantization,
    model.metadata.sizeLabel,
    model.metadata.basename,
    model.metadata.nextnPredictLayers ? "mtp" : null,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}
