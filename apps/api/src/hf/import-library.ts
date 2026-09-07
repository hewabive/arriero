import {
  isHfCommitSha,
  parseHfRepoInput,
  type ModelImportRequest,
  type ModelLibraryFile,
} from "@arriero/core";
import { libraryDestDir, listModelLibraryEntries } from "./model-library.js";
import { sanitizeRepoRelativePath } from "./paths.js";
import type { ImportRepositoryFiles } from "./model-import-plan.js";

export function libraryImportRepositories(input: ModelImportRequest): Array<{
  remote: ImportRepositoryFiles;
  destDir: string;
}> {
  const explicit = parseHfRepoInput(input.repo);
  const revision = explicit?.revision ?? input.revision;
  const result = new Map<
    string,
    { remote: ImportRepositoryFiles; destDir: string }
  >();
  for (const entry of listModelLibraryEntries()) {
    if (
      explicit
        ? entry.repoId !== explicit.repoId
        : !entry.repoId.toLowerCase().includes(input.repo.trim().toLowerCase())
    )
      continue;
    if (
      revision !== "main" &&
      !isHfCommitSha(revision) &&
      entry.watchRevision !== revision
    )
      continue;
    const snapshots = [
      { revision: entry.revision, files: entry.pinnedFiles },
      ...(entry.snapshot ? [entry.snapshot] : []),
    ];
    for (const snapshot of snapshots) {
      if (!isHfCommitSha(snapshot.revision) || !snapshot.files.length) continue;
      if (
        isHfCommitSha(revision) &&
        snapshot.revision.toLowerCase() !== revision.toLowerCase()
      )
        continue;
      const key = `${entry.repoId}\0${snapshot.revision}\0${libraryDestDir(entry)}`;
      const existing = result.get(key);
      const files = new Map(
        existing?.remote.files.map((file) => [file.path, file]),
      );
      for (const file of snapshot.files) {
        if (!validLibraryFile(file)) continue;
        const known = files.get(file.path);
        if (
          known &&
          (known.size !== file.size ||
            (known.lfs?.oid ?? known.oid) !== (file.lfsOid ?? file.oid))
        )
          throw new Error(
            `Model library has conflicting hashes for ${entry.repoId}@${snapshot.revision}: ${file.path}`,
          );
        files.set(file.path, {
          path: sanitizeRepoRelativePath(file.path),
          size: file.size,
          oid: file.oid,
          lfs: file.lfsOid ? { oid: file.lfsOid, size: file.size } : null,
        });
      }
      if (files.size)
        result.set(key, {
          destDir: libraryDestDir(entry),
          remote: {
            repoId: entry.repoId,
            commitSha: snapshot.revision,
            files: [...files.values()],
          },
        });
    }
  }
  return [...result.values()];
}

function validLibraryFile(file: ModelLibraryFile): boolean {
  return file.lfsOid
    ? /^[a-f0-9]{64}$/i.test(file.lfsOid)
    : /^[a-f0-9]{40}$/i.test(file.oid);
}
