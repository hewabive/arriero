import {
  PathCatalogEntrySchema,
  type PathCatalogCreate,
  type PathCatalogEntry,
  type PathCatalogKind,
  type PathCatalogUpdate,
} from "@llama-manager/core";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { newId } from "../utils/id.js";

export const PATH_CATALOG_FILE = resolve(config.configDir, "path-catalog.json");

let cache: PathCatalogEntry[] | null = null;

function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function load(): PathCatalogEntry[] {
  if (cache) {
    return cache;
  }
  let entries: PathCatalogEntry[] = [];
  if (existsSync(PATH_CATALOG_FILE)) {
    const raw = readFileSync(PATH_CATALOG_FILE, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${PATH_CATALOG_FILE}: ${(error as Error).message}`,
      );
    }
    const parsed = z.array(PathCatalogEntrySchema).safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Invalid config in ${PATH_CATALOG_FILE}: ${parsed.error.message}`,
      );
    }
    entries = parsed.data;
  }
  cache = entries;
  return entries;
}

function persist(entries: PathCatalogEntry[]) {
  atomicWrite(PATH_CATALOG_FILE, `${JSON.stringify(entries, null, 2)}\n`);
  cache = entries;
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

  const nextName = input.name ?? current.name;
  if (nextName !== current.name) {
    assertNameAvailable(entries, current.kind, nextName, id);
  }

  const nextEngineKind =
    input.engineKind === undefined
      ? current.engineKind
      : (input.engineKind ?? undefined);
  const updated: PathCatalogEntry = {
    id: current.id,
    kind: current.kind,
    name: nextName,
    path: input.path ?? current.path,
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
  cache = null;
}
