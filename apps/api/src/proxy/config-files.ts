import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { config } from "../config.js";
import { CONFIG_GITIGNORE_CONTENT } from "../config-git/machine-state.js";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "../config-store/file-store.js";

const stores = new Map<string, JsonFileStore<unknown>>();

function proxyFilePath(fileName: string): string {
  return resolve(config.proxyConfigDir, fileName);
}

function storeFor<T>(
  fileName: string,
  schema: z.ZodType<T>,
  missing: unknown,
): JsonFileStore<T> {
  const existing = stores.get(fileName);
  if (existing) {
    return existing as JsonFileStore<T>;
  }
  const created = createJsonFileStore<T>({
    id: `proxy:${fileName}`,
    path: proxyFilePath(fileName),
    schema,
    missing: () => missing,
    portablePaths: false,
    cache: "process",
  });
  stores.set(fileName, created as JsonFileStore<unknown>);
  return created;
}

export function readCollection<T>(fileName: string, schema: z.ZodType<T>): T[] {
  return storeFor<T[]>(fileName, z.array(schema), []).read();
}

export function writeCollection<T>(
  fileName: string,
  schema: z.ZodType<T>,
  records: T[],
): void {
  storeFor<T[]>(fileName, z.array(schema), []).write(records);
}

export function readObjectFile<T>(fileName: string, schema: z.ZodType<T>): T {
  return storeFor<T>(fileName, schema, {}).read();
}

export function writeObjectFile<T>(
  fileName: string,
  schema: z.ZodType<T>,
  value: T,
): void {
  storeFor<T>(fileName, schema, {}).write(value);
}

const secretsStore = createJsonFileStore<Record<string, string>>({
  id: "proxy:secrets",
  path: config.secretsFile,
  schema: z.record(z.string(), z.string()).catch({}),
  missing: () => ({}),
  portablePaths: false,
  cache: "process",
});

export function readSecret(id: string): string | null {
  return secretsStore.read()[id] ?? null;
}

export function setSecret(id: string, key: string | null): void {
  const next = { ...secretsStore.read() };
  if (key) {
    next[id] = key;
  } else {
    delete next[id];
  }
  secretsStore.write(next);
}

export function ensureConfigScaffold(): void {
  mkdirSync(config.proxyConfigDir, { recursive: true });
  if (!existsSync(config.configGitignoreFile)) {
    writeFileSync(config.configGitignoreFile, CONFIG_GITIGNORE_CONTENT, "utf8");
  }
}

export function resetConfigFilesCache(): void {
  for (const store of stores.values()) {
    store.reset();
  }
  secretsStore.reset();
}
