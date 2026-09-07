import {
  groupGgufFiles,
  type ModelLibraryCheck,
  type ModelLibraryFile,
  type ModelLibrarySnapshot,
} from "@arriero/core";

export function modelLibraryFileRows(
  pinned: ModelLibrarySnapshot | null,
  latest: ModelLibrarySnapshot | null,
  changes: ModelLibraryCheck["changes"],
  savedPaths: string[],
) {
  const before = new Map(pinned?.files.map((file) => [file.path, file]));
  const after = new Map(latest?.files.map((file) => [file.path, file]));
  const changed = new Map(changes.map((file) => [file.path, file.kind]));
  const saved = new Set(savedPaths);
  const paths = [
    ...new Set([
      ...before.keys(),
      ...after.keys(),
      ...changed.keys(),
      ...saved,
    ]),
  ];
  return groupGgufFiles(paths, (path) => path)
    .map((group) => {
      const collect = (files: Map<string, ModelLibraryFile>) =>
        group.files.flatMap((path) =>
          files.has(path) ? [files.get(path)!] : [],
        );
      const pinnedFiles = collect(before),
        latestFiles = collect(after);
      const kinds = [
        ...new Set(
          group.files.flatMap((path) =>
            changed.has(path) ? [changed.get(path)!] : [],
          ),
        ),
      ];
      const pinnedComplete =
        group.complete && pinnedFiles.length === group.files.length;
      const latestComplete =
        group.complete && latestFiles.length === group.files.length;
      const contentChanged =
        !!pinned &&
        !!latest &&
        group.files.some((path) => {
          const old = before.get(path),
            next = after.get(path);
          return (
            !old ||
            !next ||
            old.size !== next.size ||
            (old.lfsOid ?? old.oid) !== (next.lfsOid ?? next.oid)
          );
        });
      return {
        paths: group.files,
        pinnedFiles,
        latestFiles,
        pinnedComplete,
        latestComplete,
        kinds,
        contentChanged,
        saved: group.files.some((path) => saved.has(path)),
      };
    })
    .sort(
      (a, b) =>
        Number(b.saved) - Number(a.saved) ||
        Number(b.kinds.length > 0) - Number(a.kinds.length > 0) ||
        a.paths[0]!.localeCompare(b.paths[0]!),
    );
}
