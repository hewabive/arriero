import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { fromPortableConfig, toPortableConfig } from "../config-paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { ConfigFileError } from "./errors.js";
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

export function createJsonFileStore<T>(
  options: JsonFileStoreOptions<T>,
): JsonFileStore<T> {
  const { id, path, schema, missing, portablePaths, cache } = options;
  let cached: { value: T } | null = null;

  function load(): T {
    const raw = existsSync(path)
      ? parseConfigJson(path, readFileSync(path, "utf8"))
      : missing();
    const input = portablePaths ? fromPortableConfig(raw) : raw;
    return parseConfigValue(path, schema, input);
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
    const rendered = options.render ? options.render(value) : value;
    const serialized = portablePaths ? toPortableConfig(rendered) : rendered;
    atomicWriteFile(path, serializeConfigJson(serialized));
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
  }

  registerConfigStore({ id, files: () => [path], reset });
  return { id, path, read, write, replaceCachedValue, reset };
}
