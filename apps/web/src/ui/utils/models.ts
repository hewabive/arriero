import type {
  GgufModel,
  ArgumentDefault,
  ModelPresetEntry,
} from "@arriero/core";

import { createUiId } from "./id";

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

export function displayNameFromFileName(name: string) {
  return name.replace(/-\d+-of-\d+\.gguf$/i, "").replace(/\.gguf$/i, "");
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
    pathBaseName(path)
      .replace(/\.gguf$/i, "")
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
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

function presetEntryNameFromModel(model: GgufModel) {
  const baseName = model.metadata.name || model.name.replace(/\.gguf$/i, "");
  return baseName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function applyPresetDefaults(
  entry: ModelPresetEntry,
  defaults: ArgumentDefault[],
) {
  let next = { ...entry };

  for (const item of defaults) {
    const key = item.key.trim().replace(/^-+/, "");
    const value = item.value.trim();
    if (!key || (!value && item.valueType !== "flag")) {
      continue;
    }

    if (key === "mmproj") {
      next = { ...next, mmprojPath: value || null };
    }
  }

  return next;
}

export function presetEntryFromModel(
  model: GgufModel,
  defaults: ArgumentDefault[] = [],
): ModelPresetEntry {
  return applyPresetDefaults(
    {
      id: createUiId("preset"),
      name: presetEntryNameFromModel(model),
      modelPath: model.path,
      mmprojPath: model.mmprojPaths[0] ?? null,
      extraArgs: {},
    },
    defaults,
  );
}

export function remotePresetEntry(): ModelPresetEntry {
  return {
    id: createUiId("preset"),
    name: "remote-model",
    modelPath: "",
    mmprojPath: null,
    extraArgs: {},
  };
}

export type PresetEntrySource = "local" | "hf" | "url";

function extraArgConfigured(entry: ModelPresetEntry, key: string) {
  return Boolean(entry.extraArgs[key]?.trim());
}

export function presetEntrySource(entry: ModelPresetEntry): PresetEntrySource {
  if (extraArgConfigured(entry, "hf-repo")) {
    return "hf";
  }
  if (extraArgConfigured(entry, "model-url")) {
    return "url";
  }
  return "local";
}
