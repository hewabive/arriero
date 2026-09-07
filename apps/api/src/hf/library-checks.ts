import {
  ModelLibrarySnapshotSchema,
  type ModelLibraryEntry,
  type ModelLibraryCheck,
  type ModelLibrarySnapshot,
} from "@arriero/core";
import { browseHfRepo } from "./browse.js";
import type { HfClientOptions } from "./client.js";
import { HfDownloadRequestError } from "./paths.js";
import { logger } from "../logger.js";

const checks = new Map<
  string,
  { identity: string; check: ModelLibraryCheck }
>();
export function getLibraryCheck(entry: ModelLibraryEntry): ModelLibraryCheck {
  const cached = checks.get(entry.id);
  return cached?.identity === JSON.stringify(entry)
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
  const repo = await browseHfRepo(
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
      .map((file) => ({
        path: file.path,
        size: file.size,
        oid: file.oid,
        lfsOid: file.lfs?.oid ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}
export async function checkLibraryEntry(
  entry: ModelLibraryEntry,
  options?: HfClientOptions,
): Promise<ModelLibraryCheck> {
  let check: ModelLibraryCheck;
  try {
    const baseline =
      entry.snapshot ??
      (await fetchLibrarySnapshot(entry.repoId, entry.revision, options));
    const snapshot = await fetchLibrarySnapshot(
      entry.repoId,
      entry.watchRevision,
      options,
    );
    const before = new Map(baseline.files.map((file) => [file.path, file]));
    const after = new Map(snapshot.files.map((file) => [file.path, file]));
    const changes: ModelLibraryCheck["changes"] = [];
    for (const file of snapshot.files) {
      const old = before.get(file.path);
      if (!old) changes.push({ path: file.path, kind: "added" });
      else if (
        old.size !== file.size ||
        (old.lfsOid ?? old.oid) !== (file.lfsOid ?? file.oid)
      )
        changes.push({ path: file.path, kind: "updated" });
    }
    for (const file of baseline.files)
      if (!after.has(file.path))
        changes.push({ path: file.path, kind: "deleted" });
    check = {
      status: baseline.revision === snapshot.revision ? "current" : "changed",
      checkedAt: new Date().toISOString(),
      error: null,
      snapshot,
      changes,
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
  checks.set(entry.id, { identity: JSON.stringify(entry), check });
  return check;
}
