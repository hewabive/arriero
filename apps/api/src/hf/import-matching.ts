import { groupGgufFiles, type HfRepoBrowse } from "@arriero/core";
import { basename } from "node:path";
import { hashImportFile } from "./import-content.js";
import type { ImportSourceFile } from "./model-import-plan.js";
import type { VerificationObserver } from "./content-hash.js";

export async function matchImportGroup(
  sources: ImportSourceFile[],
  remote: HfRepoBrowse["files"],
  signal?: AbortSignal,
  onProgress?: VerificationObserver,
): Promise<HfRepoBrowse["files"][]> {
  const matches: HfRepoBrowse["files"][] = [];
  const ordered = [...sources].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
  const gguf = ordered[0]!.path.toLowerCase().endsWith(".gguf");
  for (const group of groupGgufFiles(remote, (file) => file.path)) {
    signal?.throwIfAborted();
    if (!group.complete || group.files.length !== ordered.length) continue;
    if (
      !group.files.every(
        (file, index) =>
          file.size === ordered[index]!.size &&
          (gguf
            ? file.path.toLowerCase().endsWith(".gguf")
            : basename(file.path) === basename(ordered[index]!.path)),
      )
    )
      continue;
    let matched = true;
    for (const [index, file] of group.files.entries()) {
      const source = ordered[index]!;
      if (
        (await hashImportFile(
          source.path,
          source.size,
          file.lfs !== null,
          signal,
          onProgress,
        )) !== (file.lfs?.oid ?? file.oid)
      ) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(group.files);
  }
  const rank = (files: HfRepoBrowse["files"]) =>
    files.reduce(
      (sum, file, index) =>
        sum +
        (file.path === ordered[index]!.relative
          ? 0
          : basename(file.path) === basename(ordered[index]!.path)
            ? 1
            : 2),
      0,
    );
  matches.sort(
    (a, b) => rank(a) - rank(b) || a[0]!.path.localeCompare(b[0]!.path),
  );
  return sources.map((source) =>
    matches.map((group) => group[ordered.indexOf(source)]!),
  );
}
