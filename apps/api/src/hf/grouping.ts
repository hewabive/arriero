import type { HfGgufVariant, HfTreeFile } from "@arriero/core";

import { parseSplitInfo } from "@arriero/core";

type HfGroupableFile = Pick<HfTreeFile, "path" | "size">;

const QUANT_LABEL_PATTERN =
  /(?:^|[-_.])((?:UD-)?(?:IQ\d|Q\d|TQ\d|MXFP\d)(?:_[A-Z0-9]{1,4}){0,2}|BF16|F16|F32)(?=$|[-_.])/g;

const QUANT_DIR_PATTERN =
  /^((?:UD-)?(?:IQ\d|Q\d|TQ\d|MXFP\d)(?:_[A-Z0-9]{1,4}){0,2}|BF16|F16|F32)$/;

function quantLabelFromName(name: string): string | null {
  const matches = [...name.toUpperCase().matchAll(QUANT_LABEL_PATTERN)];
  const last = matches[matches.length - 1];
  return last?.[1] ?? null;
}

function quantLabelFromDir(directory: string): string | null {
  const parent = directory.split("/").filter(Boolean).at(-1) ?? "";
  const match = QUANT_DIR_PATTERN.exec(parent.toUpperCase());
  return match?.[1] ?? null;
}

function splitPath(path: string): { directory: string; name: string } {
  const index = path.lastIndexOf("/");
  return index === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, index), name: path.slice(index + 1) };
}

type VariantDraft = {
  label: string | null;
  kind: HfGgufVariant["kind"];
  files: HfGroupableFile[];
  splitCount: number | null;
  indices: Set<number>;
};

export function groupHfGgufFiles(
  files: readonly HfGroupableFile[],
): HfGgufVariant[] | null {
  const drafts = new Map<string, VariantDraft>();
  let sawGguf = false;

  for (const file of files) {
    const { directory, name } = splitPath(file.path);
    if (!name.toLowerCase().endsWith(".gguf")) {
      continue;
    }
    sawGguf = true;
    const split = parseSplitInfo(name);
    const stem = split ? split.prefix : name.slice(0, -".gguf".length);
    const key = split ? `${directory}\0${split.prefix}` : file.path;
    const label = quantLabelFromDir(directory) ?? quantLabelFromName(stem);
    const kind = stem.toLowerCase().includes("mmproj")
      ? "mmproj"
      : label
        ? "model"
        : "other";
    const existing = drafts.get(key);
    if (existing) {
      existing.files.push(file);
      if (split) {
        existing.indices.add(split.index);
      }
      continue;
    }
    drafts.set(key, {
      label,
      kind,
      files: [file],
      splitCount: split ? split.count : null,
      indices: new Set(split ? [split.index] : []),
    });
  }

  if (!sawGguf) {
    return null;
  }

  const kindOrder: Record<HfGgufVariant["kind"], number> = {
    model: 0,
    other: 1,
    mmproj: 2,
  };

  return [...drafts.values()]
    .map((draft) => {
      const paths = draft.files.map((file) => file.path).sort();
      const complete =
        draft.splitCount === null || draft.indices.size === draft.splitCount;
      return {
        label: draft.label,
        kind: draft.kind,
        paths,
        totalBytes: draft.files.reduce((sum, file) => sum + file.size, 0),
        splitCount: draft.splitCount,
        complete,
      };
    })
    .sort((a, b) => {
      if (kindOrder[a.kind] !== kindOrder[b.kind]) {
        return kindOrder[a.kind] - kindOrder[b.kind];
      }
      if (a.label !== b.label) {
        if (a.label === null) return 1;
        if (b.label === null) return -1;
        return a.label.localeCompare(b.label);
      }
      return (a.paths[0] ?? "").localeCompare(b.paths[0] ?? "");
    });
}
