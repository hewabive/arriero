import {
  GGUF_ARTIFACT_KIND_LABEL,
  hfManifestOidMatches,
  type HfDownloadedRepoFile,
  type HfGgufVariant,
  type HfTreeFile,
} from "@arriero/core";

import { pathBaseName } from "./models";

export function hfVariantTitle(variant: HfGgufVariant): string {
  if (variant.label) {
    return variant.label;
  }
  return pathBaseName(variant.paths[0] ?? "");
}

export function hfVariantChipLabel(variant: HfGgufVariant): string {
  const title = hfVariantTitle(variant);
  if (!variant.label || variant.kind === "model" || variant.kind === "other") {
    return title;
  }
  return `${GGUF_ARTIFACT_KIND_LABEL[variant.kind]} ${title}`;
}

export type HfLocalFileState = "current" | "changed" | "absent";

export function hfLocalFileState(
  file: HfTreeFile,
  localFiles: ReadonlyMap<string, HfDownloadedRepoFile>,
): HfLocalFileState {
  const entry = localFiles.get(file.path);
  if (!entry || !entry.present) {
    return "absent";
  }
  return hfManifestOidMatches(entry, file) ? "current" : "changed";
}

export type HfLocalVariantState = "on-disk" | "partial" | "changed" | null;

export function hfLocalVariantState(
  paths: readonly string[],
  fileByPath: ReadonlyMap<string, HfTreeFile>,
  localFiles: ReadonlyMap<string, HfDownloadedRepoFile>,
): HfLocalVariantState {
  const states = paths.map((path) => {
    const file = fileByPath.get(path);
    return file ? hfLocalFileState(file, localFiles) : "absent";
  });
  if (states.every((state) => state === "current")) {
    return "on-disk";
  }
  if (states.every((state) => state === "absent")) {
    return null;
  }
  if (states.some((state) => state === "absent")) {
    return "partial";
  }
  return "changed";
}
