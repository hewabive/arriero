import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

import type { ConfigStoreFileState } from "@arriero/core";

import { fromPortableConfig, toPortableConfig } from "../config-paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { ConfigFileError, ConfigWriteConflictError } from "./errors.js";
import { registerConfigStore } from "./registry.js";

export type ConfigCacheMode = "process" | "per-read";

export type JsonFileStoreOptions<T> = {
  id: string;
  path: string;
  schema: z.ZodType<T>;
  missing: () => unknown;
  portablePaths: boolean;
  cache: ConfigCacheMode;
  render?: (value: T) => unknown;
};

export type JsonFileStore<T> = {
  id: string;
  path: string;
  read: () => T;
  write: (value: T) => void;
  replaceCachedValue: (value: T) => void;
  reset: () => void;
};

export function serializeConfigJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseConfigJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigFileError(path, "json", (error as Error).message);
  }
}

export function parseConfigValue<T>(
  path: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigFileError(path, "schema", parsed.error.message);
  }
  return parsed.data;
}

export function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function createJsonFileStore<T>(
  options: JsonFileStoreOptions<T>,
): JsonFileStore<T> {
  const { id, path, schema, missing, portablePaths, cache } = options;
  let cached: { value: T } | null = null;
  let loaded: { mtimeMs: number | null } | null = null;

  function load(): T {
    const mtimeMs = fileMtimeMs(path);
    const raw =
      mtimeMs !== null
        ? parseConfigJson(path, readFileSync(path, "utf8"))
        : missing();
    const input = portablePaths ? fromPortableConfig(raw) : raw;
    const value = parseConfigValue(path, schema, input);
    loaded = { mtimeMs };
    return value;
  }

  function read(): T {
    if (cache === "process" && cached) {
      return cached.value;
    }
    const value = load();
    if (cache === "process") {
      cached = { value };
    }
    return value;
  }

  function write(value: T): void {
    if (loaded && fileMtimeMs(path) !== loaded.mtimeMs) {
      throw new ConfigWriteConflictError(path);
    }
    const rendered = options.render ? options.render(value) : value;
    const serialized = portablePaths ? toPortableConfig(rendered) : rendered;
    atomicWriteFile(path, serializeConfigJson(serialized));
    loaded = { mtimeMs: fileMtimeMs(path) };
    if (cache === "process") {
      cached = { value };
    }
  }

  function replaceCachedValue(value: T): void {
    if (cache !== "process") {
      throw new Error(`config store ${id} does not cache values`);
    }
    cached = { value };
  }

  function reset(): void {
    cached = null;
    loaded = null;
  }

  function status(): ConfigStoreFileState[] {
    const diskMtimeMs = fileMtimeMs(path);
    return [
      {
        storeId: id,
        path,
        cacheMode: cache,
        exists: diskMtimeMs !== null,
        diskMtimeMs,
        loadedMtimeMs: loaded?.mtimeMs ?? null,
        dirtyOnDisk:
          cache === "per-read" || !loaded
            ? null
            : diskMtimeMs !== loaded.mtimeMs,
      },
    ];
  }

  registerConfigStore({ id, files: () => [path], reset, status });
  return { id, path, read, write, replaceCachedValue, reset };
}
