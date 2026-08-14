import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { ConfigStoreFileState } from "@arriero/core";

import { fromPortableConfig, toPortableConfig } from "../config-paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { ConfigFileError, ConfigWriteConflictError } from "./errors.js";
import {
  fileMtimeMs,
  parseConfigJson,
  parseConfigValue,
  serializeConfigJson,
} from "./file-store.js";
import { registerConfigStore } from "./registry.js";

export type JsonDirectoryStoreOptions<T> = {
  id: string;
  dir: string;
  schema: z.ZodType<T>;
  key: (value: T) => string;
  portablePaths: boolean;
};

export type JsonDirectoryStore<T> = {
  id: string;
  dir: string;
  filePath: (key: string) => string;
  list: () => T[];
  get: (key: string) => T | null;
  listInvalidFiles: () => ConfigFileError[];
  write: (value: T, previousKey?: string) => void;
  remove: (key: string) => boolean;
  reset: () => void;
};

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(dir, entry.name));
}

export function createJsonDirectoryStore<T>(
  options: JsonDirectoryStoreOptions<T>,
): JsonDirectoryStore<T> {
  const { id, dir, schema, key, portablePaths } = options;
  let cached: Map<string, T> | null = null;
  let loadedMtimes: Map<string, number> | null = null;
  let invalid: Map<string, ConfigFileError> | null = null;

  function filePath(name: string): string {
    return resolve(dir, `${name}.json`);
  }

  function parseFile(path: string): T {
    const raw = parseConfigJson(path, readFileSync(path, "utf8"));
    const input = portablePaths ? fromPortableConfig(raw) : raw;
    return parseConfigValue(path, schema, input);
  }

  function load(): Map<string, T> {
    if (cached) {
      return cached;
    }
    const next = new Map<string, T>();
    const mtimes = new Map<string, number>();
    const broken = new Map<string, ConfigFileError>();
    for (const path of listJsonFiles(dir)) {
      let value: T;
      try {
        value = parseFile(path);
      } catch (error) {
        if (error instanceof ConfigFileError) {
          broken.set(path, error);
          continue;
        }
        throw error;
      }
      next.set(key(value), value);
      const mtimeMs = fileMtimeMs(path);
      if (mtimeMs !== null) {
        mtimes.set(path, mtimeMs);
      }
    }
    cached = next;
    loadedMtimes = mtimes;
    invalid = broken;
    return next;
  }

  function list(): T[] {
    return [...load().values()];
  }

  function get(name: string): T | null {
    return load().get(name) ?? null;
  }

  function listInvalidFiles(): ConfigFileError[] {
    load();
    return [...(invalid?.values() ?? [])];
  }

  function write(value: T, previousKey?: string): void {
    const map = load();
    const name = key(value);
    const path = filePath(name);
    if (
      loadedMtimes &&
      fileMtimeMs(path) !== (loadedMtimes.get(path) ?? null)
    ) {
      throw new ConfigWriteConflictError(path);
    }
    const serialized = portablePaths ? toPortableConfig(value) : value;
    atomicWriteFile(path, serializeConfigJson(serialized));
    const mtimeMs = fileMtimeMs(path);
    if (mtimeMs !== null) {
      loadedMtimes?.set(path, mtimeMs);
    }
    if (previousKey && previousKey !== name) {
      const previousPath = filePath(previousKey);
      if (existsSync(previousPath)) {
        unlinkSync(previousPath);
      }
      map.delete(previousKey);
      loadedMtimes?.delete(previousPath);
    }
    map.set(name, value);
  }

  function remove(name: string): boolean {
    const map = load();
    const value = map.get(name);
    if (!value) {
      return false;
    }
    const path = filePath(key(value));
    if (existsSync(path)) {
      unlinkSync(path);
    }
    map.delete(name);
    loadedMtimes?.delete(path);
    return true;
  }

  function reset(): void {
    cached = null;
    loadedMtimes = null;
    invalid = null;
  }

  function status(): ConfigStoreFileState[] {
    const disk = new Map<string, number>();
    for (const path of listJsonFiles(dir)) {
      const mtimeMs = fileMtimeMs(path);
      if (mtimeMs !== null) {
        disk.set(path, mtimeMs);
      }
    }
    const paths = new Set([...disk.keys(), ...(loadedMtimes?.keys() ?? [])]);
    return [...paths].sort().map((path) => {
      const diskMtimeMs = disk.get(path) ?? null;
      const loadedMtimeMs = loadedMtimes?.get(path) ?? null;
      return {
        storeId: id,
        path,
        cacheMode: "process" as const,
        exists: diskMtimeMs !== null,
        diskMtimeMs,
        loadedMtimeMs,
        dirtyOnDisk: loadedMtimes ? diskMtimeMs !== loadedMtimeMs : null,
        error: invalid?.get(path)?.message ?? null,
      };
    });
  }

  registerConfigStore({
    id,
    files: () => listJsonFiles(dir),
    init: () => {
      load();
    },
    reset,
    status,
  });
  return {
    id,
    dir,
    filePath,
    list,
    get,
    listInvalidFiles,
    write,
    remove,
    reset,
  };
}
