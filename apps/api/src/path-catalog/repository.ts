import {
  PathCatalogEntrySchema,
  type PathCatalogCreate,
  type PathCatalogEntry,
  type PathCatalogKind,
  type PathCatalogUpdate,
} from "@arriero/core";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { newId } from "../utils/id.js";

export const PATH_CATALOG_FILE = resolve(config.configDir, "path-catalog.json");

const store = createJsonFileStore<PathCatalogEntry[]>({
  id: "path-catalog",
  path: PATH_CATALOG_FILE,
  schema: z.array(PathCatalogEntrySchema),
  missing: () => [],
  portablePaths: true,
  cache: "process",
});

function nowIso() {
  return new Date().toISOString();
}

function load(): PathCatalogEntry[] {
  return store.read();
}

function persist(entries: PathCatalogEntry[]) {
  store.write(entries);
}

function sortEntries(entries: PathCatalogEntry[]): PathCatalogEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
}

function assertNameAvailable(
  entries: PathCatalogEntry[],
  kind: PathCatalogKind,
  name: string,
  excludeId?: string,
) {
  const clash = entries.some(
    (entry) =>
      entry.id !== excludeId && entry.kind === kind && entry.name === name,
  );
  if (clash) {
    throw new Error(`path catalog entry "${name}" already exists`);
  }
}

export function seedPathCatalog(entries: PathCatalogEntry[]): void {
  persist(sortEntries(entries));
}

export function listPathCatalogEntries(
  kind?: PathCatalogKind,
): PathCatalogEntry[] {
  const entries = load();
  const filtered = kind
    ? entries.filter((entry) => entry.kind === kind)
    : entries;
  return sortEntries(filtered);
}

export function getPathCatalogEntry(id: string): PathCatalogEntry | null {
  return load().find((entry) => entry.id === id) ?? null;
}

export function createPathCatalogEntry(
  input: PathCatalogCreate,
): PathCatalogEntry {
  if (input.kind !== "binary" && input.engineKind) {
    throw new Error("engine kind is only valid for binary catalog entries");
  }
  const entries = load();
  assertNameAvailable(entries, input.kind, input.name);

  const timestamp = nowIso();
  const created: PathCatalogEntry = {
    id: newId(),
    kind: input.kind,
    name: input.name,
    path: input.path,
    ...(input.engineKind ? { engineKind: input.engineKind } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  persist(sortEntries([...entries, created]));
  return created;
}

export function updatePathCatalogEntry(
  id: string,
  input: PathCatalogUpdate,
): PathCatalogEntry | null {
  const entries = load();
  const current = entries.find((entry) => entry.id === id);
  if (!current) {
    return null;
  }
  if (current.kind !== "binary" && input.engineKind !== undefined) {
    throw new Error("engine kind is only valid for binary catalog entries");
  }

  const nextName = input.name ?? current.name;
  if (nextName !== current.name) {
    assertNameAvailable(entries, current.kind, nextName, id);
  }

  const nextEngineKind =
    input.engineKind === undefined
      ? current.engineKind
      : (input.engineKind ?? undefined);
  const nextPath = input.path ?? current.path;
  if (
    nextName === current.name &&
    nextPath === current.path &&
    nextEngineKind === current.engineKind
  ) {
    return current;
  }
  const updated: PathCatalogEntry = {
    id: current.id,
    kind: current.kind,
    name: nextName,
    path: nextPath,
    ...(nextEngineKind ? { engineKind: nextEngineKind } : {}),
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  persist(
    sortEntries(entries.map((entry) => (entry.id === id ? updated : entry))),
  );
  return updated;
}

export function deletePathCatalogEntry(id: string): boolean {
  const entries = load();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) {
    return false;
  }
  persist(next);
  return true;
}

export function resetPathCatalogCache(): void {
  store.reset();
}
