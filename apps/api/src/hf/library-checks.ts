import {
  ModelLibrarySnapshotSchema,
  sameHfContent,
  type ModelLibraryEntry,
  type ModelLibraryCheck,
  type ModelLibrarySnapshot,
} from "@arriero/core";
import { browseHfRepoFiles } from "./browse.js";
import type { HfClientOptions } from "./client.js";
import { hfManifestFileFromTree } from "./manifest.js";
import { HfDownloadRequestError } from "./paths.js";
import { logger } from "../logger.js";

const checks = new Map<
  string,
  { identity: string; check: ModelLibraryCheck }
>();
const entryIdentities = new WeakMap<ModelLibraryEntry, string>();

function entryIdentity(entry: ModelLibraryEntry): string {
  let identity = entryIdentities.get(entry);
  if (identity === undefined) {
    identity = JSON.stringify(entry);
    entryIdentities.set(entry, identity);
  }
  return identity;
}

export function getLibraryCheck(entry: ModelLibraryEntry): ModelLibraryCheck {
  const cached = checks.get(entry.id);
  return cached?.identity === entryIdentity(entry)
    ? cached.check
    : {
        status: "unchecked",
        checkedAt: null,
        error: null,
        snapshot: null,
        changes: [],
      };
}
export async function fetchLibrarySnapshot(
  repoId: string,
  revision: string,
  options?: HfClientOptions,
): Promise<ModelLibrarySnapshot> {
  const repo = await browseHfRepoFiles(
    { repoId, revision },
    { ...options, signal: options?.signal ?? AbortSignal.timeout(60000) },
  );
  if (repo.truncated)
    throw new HfDownloadRequestError(
      "Repository listing is incomplete; no snapshot was accepted",
    );
  return ModelLibrarySnapshotSchema.parse({
    revision: repo.commitSha,
    files: repo.files
      .map((file) => hfManifestFileFromTree(file))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

export async function baselineSnapshot(
  entry: ModelLibraryEntry,
  options?: HfClientOptions,
): Promise<ModelLibrarySnapshot> {
  return (
    entry.snapshot ??
    fetchLibrarySnapshot(entry.repoId, entry.revision, options)
  );
}

function compareLibrarySnapshots(
  baseline: ModelLibrarySnapshot,
  snapshot: ModelLibrarySnapshot,
): Pick<ModelLibraryCheck, "status" | "changes"> {
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(snapshot.files.map((file) => [file.path, file]));
  const changes: ModelLibraryCheck["changes"] = [];
  for (const file of snapshot.files) {
    const old = before.get(file.path);
    if (!old) changes.push({ path: file.path, kind: "added" });
    else if (!sameHfContent(old, file))
      changes.push({ path: file.path, kind: "updated" });
  }
  for (const file of baseline.files)
    if (!after.has(file.path))
      changes.push({ path: file.path, kind: "deleted" });
  return {
    status: baseline.revision === snapshot.revision ? "current" : "changed",
    changes,
  };
}

export function retainLibraryCheck(
  previous: ModelLibraryEntry,
  next: ModelLibraryEntry,
): void {
  const check = getLibraryCheck(previous);
  if (
    !check.snapshot ||
    previous.repoId !== next.repoId ||
    previous.watchRevision !== next.watchRevision
  )
    return;
  checks.set(next.id, {
    identity: entryIdentity(next),
    check: {
      ...check,
      ...(next.snapshot
        ? compareLibrarySnapshots(next.snapshot, check.snapshot)
        : {}),
    },
  });
}

export async function checkLibraryEntry(
  entry: ModelLibraryEntry,
  options?: HfClientOptions,
): Promise<ModelLibraryCheck> {
  let check: ModelLibraryCheck;
  try {
    const baseline = await baselineSnapshot(entry, options);
    const snapshot = await fetchLibrarySnapshot(
      entry.repoId,
      entry.watchRevision,
      options,
    );
    check = {
      ...compareLibrarySnapshots(baseline, snapshot),
      checkedAt: new Date().toISOString(),
      error: null,
      snapshot,
    };
  } catch (error) {
    logger.warn(
      { err: error, repoId: entry.repoId },
      "model library update check failed",
    );
    check = {
      status: "error",
      checkedAt: new Date().toISOString(),
      error: (error as Error).message,
      snapshot: null,
      changes: [],
    };
  }
  if (checks.size >= 200) checks.delete(checks.keys().next().value!);
  checks.set(entry.id, { identity: entryIdentity(entry), check });
  return check;
}
