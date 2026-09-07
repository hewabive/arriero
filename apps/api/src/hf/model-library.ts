import {
  ModelLibraryEntrySchema,
  isHfCommitSha,
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

function persist(requirements: ModelLibraryEntry[]) {
  const sorted = [...requirements].sort(
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

export function libraryDestDir(requirement: ModelLibraryEntry): string {
  return resolve(requirement.destDir ?? defaultHfDestDir(requirement.repoId));
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
  const requirements = load();
  const existing = requirements.find(
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
    persist(
      requirements.map((item) => (item.id === existing.id ? next : item)),
    );
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
  persist([...requirements, created]);
  return created;
}

export function deleteModelLibraryEntry(id: string): boolean {
  const requirements = load();
  const next = requirements.filter((item) => item.id !== id);
  if (next.length === requirements.length) {
    return false;
  }
  persist(next);
  return true;
}

export function captureModelLibraryEntry(job: {
  repoId: string;
  revision: string;
  destDir: string;
  files: {
    path: string;
    size?: number;
    oid?: string | undefined;
    lfsOid?: string | null | undefined;
  }[];
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
      pinnedFiles: job.files.flatMap((file) =>
        file.size !== undefined && file.oid
          ? [
              {
                path: file.path,
                size: file.size,
                oid: file.oid,
                lfsOid: file.lfsOid ?? null,
              },
            ]
          : [],
      ),
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
  const requirements = load();
  const matched = requirements.find(
    (item) => libraryDestDir(item) === resolvedDir,
  );
  if (!matched) {
    return;
  }
  if (paths === null) {
    persist(requirements.filter((item) => item.id !== matched.id));
    return;
  }
  const removed = new Set(paths);
  const remaining = matched.paths.filter((path) => !removed.has(path));
  if (remaining.length === matched.paths.length) {
    return;
  }
  if (remaining.length === 0) {
    persist(requirements.filter((item) => item.id !== matched.id));
    return;
  }
  persist(
    requirements.map((item) =>
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
  requirement: ModelLibraryEntry,
  repos: HfDownloadedRepo[],
): ModelLibraryEntryStatus {
  const destDir = libraryDestDir(requirement);
  const repo =
    repos.find(
      (item) =>
        resolve(item.dir) === destDir && item.repoId === requirement.repoId,
    ) ?? null;
  if (!repo) {
    return {
      entry: requirement,
      state: requirement.paths.length ? "missing" : "watching",
      matchedDir: null,
      missingPaths: [...requirement.paths],
      revisionMatch: null,
      driftPaths: [],
      check: getLibraryCheck(requirement),
    };
  }
  const presentPaths = new Set(
    repo.files.filter((file) => file.present).map((file) => file.path),
  );
  const missingPaths = requirement.paths.filter(
    (path) => !presentPaths.has(path),
  );
  const revisionMatch =
    isHfCommitSha(requirement.revision) && isHfCommitSha(repo.revision)
      ? requirement.revision.toLowerCase() === repo.revision.toLowerCase()
      : null;
  const driftPaths = requirement.pinnedFiles
    .filter((file) => {
      const local = repo.files.find(
        (item) => item.path === file.path && item.present,
      );
      return (
        local &&
        (local.size !== file.size ||
          (local.lfsOid ?? local.oid) !== (file.lfsOid ?? file.oid))
      );
    })
    .map((file) => file.path);
  return {
    entry: requirement,
    driftPaths,
    check: getLibraryCheck(requirement),
    state:
      requirement.paths.length === 0
        ? "watching"
        : missingPaths.length === 0
          ? "satisfied"
          : missingPaths.length === requirement.paths.length
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
  return listModelLibraryEntries().map((requirement) =>
    evaluateModelLibraryEntry(requirement, repos),
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
