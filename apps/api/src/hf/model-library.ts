import {
  ModelLibraryEntrySchema,
  isHfCommitSha,
  sameHfContent,
  type HfDownloadedRepo,
  type ModelLibraryEntry,
  type ModelLibraryEntryStatus,
  type ModelLibraryFile,
} from "@arriero/core";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { logger } from "../logger.js";
import { newId } from "../utils/id.js";
import { compareStrings } from "../utils/sort.js";
import { listHfDownloads } from "./downloads.js";
import { defaultHfDestDir, HfDownloadRequestError } from "./paths.js";
import { getLibraryCheck, retainLibraryCheck } from "./library-checks.js";

export const MODEL_LIBRARY_FILE = resolve(config.configDir, "models.json");

const store = createJsonFileStore<ModelLibraryEntry[]>({
  id: "model-library",
  path: MODEL_LIBRARY_FILE,
  schema: z.array(ModelLibraryEntrySchema),
  missing: () => [],
  portablePaths: true,
  cache: "process",
});

function load(): ModelLibraryEntry[] {
  return store.read();
}

function persist(entries: ModelLibraryEntry[]) {
  const sorted = [...entries].sort(
    (left, right) =>
      compareStrings(left.repoId, right.repoId) ||
      compareStrings(left.id, right.id),
  );
  store.write(sorted);
}

export function rewriteModelLibraryEntriesFile(): void {
  persist(load());
}

function normalizedDestDir(
  repoId: string,
  destDir: string | null | undefined,
): string | null {
  if (!destDir) {
    return null;
  }
  const resolved = resolve(destDir);
  return resolved === resolve(defaultHfDestDir(repoId)) ? null : resolved;
}

export function libraryDestDir(entry: ModelLibraryEntry): string {
  return resolve(entry.destDir ?? defaultHfDestDir(entry.repoId));
}

export function listModelLibraryEntries(): ModelLibraryEntry[] {
  return [...load()];
}

export function upsertModelLibraryEntry(input: {
  repoId: string;
  revision: string;
  paths: string[];
  destDir: string | null;
  pinnedFiles?: ModelLibraryFile[];
}): ModelLibraryEntry {
  const destDir = normalizedDestDir(input.repoId, input.destDir);
  const entries = load();
  const existing = entries.find(
    (item) => item.repoId === input.repoId && item.destDir === destDir,
  );
  if (existing) {
    if (existing.revision !== input.revision) {
      logger.warn(
        {
          repoId: input.repoId,
          pinned: existing.revision,
          incoming: input.revision,
        },
        "model library pin retained; accept a new revision explicitly",
      );
      return existing;
    }
    const paths = [...new Set([...existing.paths, ...input.paths])].sort();
    const next = ModelLibraryEntrySchema.parse({
      ...existing,
      paths,
      pinnedFiles: [
        ...new Map(
          [...existing.pinnedFiles, ...(input.pinnedFiles ?? [])].map(
            (file) => [file.path, file],
          ),
        ).values(),
      ],
    });
    if (isDeepStrictEqual(existing, next)) {
      return existing;
    }
    persist(entries.map((item) => (item.id === existing.id ? next : item)));
    return next;
  }
  const created = ModelLibraryEntrySchema.parse({
    id: newId(),
    repoId: input.repoId,
    revision: input.revision,
    paths: [...new Set(input.paths)].sort(),
    pinnedFiles: input.pinnedFiles ?? [],
    destDir,
  });
  persist([...entries, created]);
  return created;
}

export function deleteModelLibraryEntry(id: string): boolean {
  const entries = load();
  const next = entries.filter((item) => item.id !== id);
  if (next.length === entries.length) {
    return false;
  }
  persist(next);
  return true;
}

export function captureModelLibraryEntry(job: {
  repoId: string;
  revision: string;
  destDir: string;
  files: ModelLibraryFile[];
}): void {
  if (job.files.length === 0) {
    return;
  }
  try {
    upsertModelLibraryEntry({
      repoId: job.repoId,
      revision: job.revision,
      paths: job.files.map((file) => file.path),
      destDir: job.destDir,
      pinnedFiles: job.files.map(({ path, size, oid, lfsOid }) => ({
        path,
        size,
        oid,
        lfsOid,
      })),
    });
  } catch (error) {
    logger.warn({ error, repoId: job.repoId }, "library entry capture failed");
  }
}

export function removeModelLibraryEntryForDeletedDownload(
  dir: string,
  paths: string[] | null,
): void {
  const resolvedDir = resolve(dir);
  const entries = load();
  const matched = entries.find((item) => libraryDestDir(item) === resolvedDir);
  if (!matched) {
    return;
  }
  const removed = paths === null ? null : new Set(paths);
  const remaining = removed
    ? matched.paths.filter((path) => !removed.has(path))
    : [];
  if (removed && remaining.length === matched.paths.length) {
    return;
  }
  if (remaining.length === 0) {
    persist(entries.filter((item) => item.id !== matched.id));
    return;
  }
  persist(
    entries.map((item) =>
      item.id === matched.id
        ? {
            ...item,
            paths: remaining,
            pinnedFiles: item.pinnedFiles.filter((file) =>
              remaining.includes(file.path),
            ),
          }
        : item,
    ),
  );
}

export function evaluateModelLibraryEntry(
  entry: ModelLibraryEntry,
  repos: HfDownloadedRepo[],
): ModelLibraryEntryStatus {
  const destDir = libraryDestDir(entry);
  const repo =
    repos.find(
      (item) => resolve(item.dir) === destDir && item.repoId === entry.repoId,
    ) ?? null;
  if (!repo) {
    return {
      entry,
      state: entry.paths.length ? "missing" : "watching",
      matchedDir: null,
      missingPaths: [...entry.paths],
      revisionMatch: null,
      driftPaths: [],
      check: getLibraryCheck(entry),
    };
  }
  const present = new Map(
    repo.files.filter((file) => file.present).map((file) => [file.path, file]),
  );
  const missingPaths = entry.paths.filter((path) => !present.has(path));
  const revisionMatch =
    isHfCommitSha(entry.revision) && isHfCommitSha(repo.revision)
      ? entry.revision.toLowerCase() === repo.revision.toLowerCase()
      : null;
  const driftPaths = entry.pinnedFiles
    .filter((file) => {
      const local = present.get(file.path);
      return local !== undefined && !sameHfContent(local, file);
    })
    .map((file) => file.path);
  return {
    entry,
    driftPaths,
    check: getLibraryCheck(entry),
    state:
      entry.paths.length === 0
        ? "watching"
        : missingPaths.length === 0
          ? "satisfied"
          : missingPaths.length === entry.paths.length
            ? "missing"
            : "partial",
    matchedDir: repo.dir,
    missingPaths,
    revisionMatch,
  };
}

export async function listModelLibraryEntryStatuses(): Promise<
  ModelLibraryEntryStatus[]
> {
  const repos = await listHfDownloads();
  return listModelLibraryEntries().map((entry) =>
    evaluateModelLibraryEntry(entry, repos),
  );
}

export function getLibraryEntry(id: string): ModelLibraryEntry {
  const entry = load().find((item) => item.id === id);
  if (!entry) throw new HfDownloadRequestError("Model library entry not found");
  return entry;
}
export function replaceLibraryEntry(
  previous: ModelLibraryEntry,
  next: ModelLibraryEntry,
): ModelLibraryEntry {
  const entries = load();
  const current = entries.find((item) => item.id === previous.id);
  if (!isDeepStrictEqual(current, previous))
    throw new HfDownloadRequestError(
      "Library entry changed; reload and try again",
    );
  const parsed = ModelLibraryEntrySchema.parse(next);
  persist(entries.map((item) => (item.id === previous.id ? parsed : item)));
  retainLibraryCheck(previous, parsed);
  return parsed;
}
