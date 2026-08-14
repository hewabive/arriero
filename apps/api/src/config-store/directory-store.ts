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
  type LoadedState = {
    values: Map<string, T>;
    mtimes: Map<string, number>;
    invalid: Map<string, ConfigFileError>;
  };
  let state: LoadedState | null = null;

  function filePath(name: string): string {
    return resolve(dir, `${name}.json`);
  }

  function parseFile(path: string): T {
    const raw = parseConfigJson(path, readFileSync(path, "utf8"));
    const input = portablePaths ? fromPortableConfig(raw) : raw;
    return parseConfigValue(path, schema, input);
  }

  function load(): LoadedState {
    if (state) {
      return state;
    }
    const values = new Map<string, T>();
    const mtimes = new Map<string, number>();
    const invalid = new Map<string, ConfigFileError>();
    for (const path of listJsonFiles(dir)) {
      let value: T;
      try {
        value = parseFile(path);
      } catch (error) {
        if (error instanceof ConfigFileError) {
          invalid.set(path, error);
          continue;
        }
        throw error;
      }
      values.set(key(value), value);
      const mtimeMs = fileMtimeMs(path);
      if (mtimeMs !== null) {
        mtimes.set(path, mtimeMs);
      }
    }
    state = { values, mtimes, invalid };
    return state;
  }

  function list(): T[] {
    return [...load().values.values()];
  }

  function get(name: string): T | null {
    return load().values.get(name) ?? null;
  }

  function listInvalidFiles(): ConfigFileError[] {
    return [...load().invalid.values()];
  }

  function write(value: T, previousKey?: string): void {
    const loaded = load();
    const name = key(value);
    const path = filePath(name);
    if (fileMtimeMs(path) !== (loaded.mtimes.get(path) ?? null)) {
      throw new ConfigWriteConflictError(path);
    }
    const serialized = portablePaths ? toPortableConfig(value) : value;
    atomicWriteFile(path, serializeConfigJson(serialized));
    const mtimeMs = fileMtimeMs(path);
    if (mtimeMs !== null) {
      loaded.mtimes.set(path, mtimeMs);
    }
    if (previousKey && previousKey !== name) {
      const previousPath = filePath(previousKey);
      if (existsSync(previousPath)) {
        unlinkSync(previousPath);
      }
      loaded.values.delete(previousKey);
      loaded.mtimes.delete(previousPath);
    }
    loaded.values.set(name, value);
  }

  function remove(name: string): boolean {
    const loaded = load();
    const value = loaded.values.get(name);
    if (!value) {
      return false;
    }
    const path = filePath(key(value));
    if (existsSync(path)) {
      unlinkSync(path);
    }
    loaded.values.delete(name);
    loaded.mtimes.delete(path);
    return true;
  }

  function reset(): void {
    state = null;
  }

  function status(): ConfigStoreFileState[] {
    const disk = new Map<string, number>();
    for (const path of listJsonFiles(dir)) {
      const mtimeMs = fileMtimeMs(path);
      if (mtimeMs !== null) {
        disk.set(path, mtimeMs);
      }
    }
    const loaded = state;
    const paths = new Set([...disk.keys(), ...(loaded?.mtimes.keys() ?? [])]);
    return [...paths].sort().map((path) => {
      const diskMtimeMs = disk.get(path) ?? null;
      const loadedMtimeMs = loaded?.mtimes.get(path) ?? null;
      return {
        storeId: id,
        path,
        cacheMode: "process" as const,
        exists: diskMtimeMs !== null,
        diskMtimeMs,
        loadedMtimeMs,
        dirtyOnDisk: loaded ? diskMtimeMs !== loadedMtimeMs : null,
        error: loaded?.invalid.get(path)?.message ?? null,
      };
    });
  }

  registerConfigStore({
    id,
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
