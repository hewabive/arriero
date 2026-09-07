import {
  groupGgufFiles,
  isHfCommitSha,
  type ModelLibraryAction,
  type ModelLibraryEntryCreate,
  type ModelLibraryEntry,
  type ModelLibrarySnapshot,
} from "@arriero/core";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  checkLibraryEntry,
  fetchLibrarySnapshot,
  getLibraryCheck,
} from "./library-checks.js";
import {
  getLibraryEntry,
  libraryDestDir,
  listModelLibraryEntries,
  replaceLibraryEntry,
  upsertModelLibraryEntry,
} from "./model-library.js";
import { enqueueHfDownload } from "./download-queue.js";
import { HfDownloadRequestError, sanitizeRepoRelativePath } from "./paths.js";
import type { HfClientOptions } from "./client.js";

export function expandLibrarySelection(
  snapshot: ModelLibrarySnapshot,
  requested: string[],
): string[] {
  const selected = new Set(requested.map(sanitizeRepoRelativePath));
  const available = new Set(snapshot.files.map((file) => file.path));
  for (const path of selected)
    if (!available.has(path))
      throw new HfDownloadRequestError(
        `File does not exist at the selected revision: ${path}`,
      );
  for (const group of groupGgufFiles(snapshot.files, (file) => file.path)) {
    if (!group.files.some((file) => selected.has(file.path))) continue;
    if (!group.complete)
      throw new HfDownloadRequestError(
        "Repository contains an incomplete GGUF shard group",
      );
    group.files.forEach((file) => selected.add(file.path));
  }
  const tensorDirs = new Set(
    [...selected]
      .filter((path) => path.endsWith(".safetensors"))
      .map((path) => posix.dirname(path)),
  );
  for (const file of snapshot.files)
    if (
      tensorDirs.has(posix.dirname(file.path)) &&
      /\.(?:safetensors|json|txt|model|tiktoken)$/i.test(file.path)
    )
      selected.add(file.path);
  for (const path of selected) {
    const match = /^(.*-)(\d{5})-of-(\d{5})(\.safetensors)$/.exec(path);
    if (!match) continue;
    const count = Number(match[3]);
    if (count < 1 || count > 2000)
      throw new HfDownloadRequestError("Invalid safetensors shard count");
    for (let index = 1; index <= count; index++)
      if (
        !selected.has(
          `${match[1]}${String(index).padStart(5, "0")}-of-${match[3]}${match[4]}`,
        )
      )
        throw new HfDownloadRequestError(
          `Incomplete safetensors group: ${path}`,
        );
  }
  if (selected.size > 2000)
    throw new HfDownloadRequestError("Select at most 2000 files");
  return [...selected].sort();
}

export async function createLibraryEntry(
  input: ModelLibraryEntryCreate,
  options?: HfClientOptions,
): Promise<ModelLibraryEntry> {
  const snapshot = await fetchLibrarySnapshot(
    input.repoId,
    input.revision,
    options,
  );
  const paths = expandLibrarySelection(snapshot, input.paths);
  const previous = listModelLibraryEntries();
  const entry = upsertModelLibraryEntry({
    ...input,
    revision: snapshot.revision,
    paths,
    pinnedFiles: snapshot.files.filter((file) => paths.includes(file.path)),
  });
  if (previous.some((item) => item.id === entry.id)) return entry;
  return replaceLibraryEntry(entry, {
    ...entry,
    snapshot,
    watchRevision: isHfCommitSha(input.revision) ? "main" : input.revision,
  });
}

export async function libraryPinnedSnapshot(
  id: string,
  options?: HfClientOptions,
): Promise<ModelLibrarySnapshot> {
  const entry = getLibraryEntry(id);
  return fetchLibrarySnapshot(entry.repoId, entry.revision, options);
}

export async function actOnLibraryEntry(
  id: string,
  action: ModelLibraryAction,
  options?: HfClientOptions,
): Promise<void> {
  const entry = getLibraryEntry(id);
  if (action.action === "check") {
    await checkLibraryEntry(entry, options);
    return;
  }
  if (action.action === "acknowledge" || action.action === "pin") {
    const check = getLibraryCheck(entry);
    if (!check.snapshot || check.snapshot.revision !== action.revision)
      throw new HfDownloadRequestError(
        "Check the repository again before accepting this revision",
      );
    if (action.action === "acknowledge") {
      replaceLibraryEntry(entry, { ...entry, snapshot: check.snapshot });
      return;
    }
    const paths = expandLibrarySelection(
      check.snapshot,
      action.paths ?? entry.paths,
    );
    const snapshot =
      entry.snapshot ??
      (await fetchLibrarySnapshot(entry.repoId, entry.revision, options));
    replaceLibraryEntry(entry, {
      ...entry,
      snapshot,
      revision: check.snapshot.revision,
      paths,
      pinnedFiles: check.snapshot.files.filter((file) =>
        paths.includes(file.path),
      ),
    });
    return;
  }
  if (isHfCommitSha(entry.revision) && action.revision !== entry.revision)
    throw new HfDownloadRequestError(
      "Pinned revision changed; reopen the file selection",
    );
  const snapshot = await fetchLibrarySnapshot(
    entry.repoId,
    action.revision ?? entry.revision,
    options,
  );
  const paths = expandLibrarySelection(snapshot, action.paths ?? entry.paths);
  if (action.action === "select") {
    replaceLibraryEntry(entry, {
      ...entry,
      revision: snapshot.revision,
      paths,
      pinnedFiles: snapshot.files.filter((file) => paths.includes(file.path)),
    });
    return;
  }
  if (!isHfCommitSha(entry.revision))
    throw new HfDownloadRequestError(
      "Save the file selection to pin this legacy entry before downloading",
    );
  if (!paths.length || paths.some((path) => !entry.paths.includes(path)))
    throw new HfDownloadRequestError(
      "Choose files from the saved selection; save new files first",
    );
  if (!isDeepStrictEqual(entry, getLibraryEntry(id)))
    throw new HfDownloadRequestError("Library entry changed; try again");
  await enqueueHfDownload(
    {
      repoId: entry.repoId,
      revision: entry.revision,
      destDir: libraryDestDir(entry),
      paths,
    },
    options,
  );
}
