import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { config } from "../config.js";
import { CONFIG_GITIGNORE_CONTENT } from "../config-git/machine-state.js";
import {
  createJsonFileStore,
  parseConfigJson,
  serializeConfigJson,
  type JsonFileStore,
} from "../config-store/file-store.js";
import { registerConfigStore } from "../config-store/registry.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const stores = new Map<string, JsonFileStore<unknown>>();
let secretsCache: Record<string, string> | null = null;

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

function writeValue(fileName: string, value: unknown): void {
  const store = stores.get(fileName);
  if (store) {
    store.write(value);
    return;
  }
  atomicWriteFile(proxyFilePath(fileName), serializeConfigJson(value));
}

export function readCollection<T>(fileName: string, schema: z.ZodType<T>): T[] {
  return storeFor<T[]>(fileName, z.array(schema), []).read();
}

export function writeCollection<T>(fileName: string, records: T[]): void {
  writeValue(fileName, records);
}

export function readObjectFile<T>(fileName: string, schema: z.ZodType<T>): T {
  return storeFor<T>(fileName, schema, {}).read();
}

export function writeObjectFile<T>(fileName: string, value: T): void {
  writeValue(fileName, value);
}

function loadSecrets(): Record<string, string> {
  if (secretsCache) {
    return secretsCache;
  }
  if (existsSync(config.secretsFile)) {
    const parsed = z
      .record(z.string(), z.string())
      .safeParse(
        parseConfigJson(
          config.secretsFile,
          readFileSync(config.secretsFile, "utf8"),
        ),
      );
    secretsCache = parsed.success ? parsed.data : {};
  } else {
    secretsCache = {};
  }
  return secretsCache;
}

export function readSecret(id: string): string | null {
  return loadSecrets()[id] ?? null;
}

export function setSecret(id: string, key: string | null): void {
  const next = { ...loadSecrets() };
  if (key) {
    next[id] = key;
  } else {
    delete next[id];
  }
  atomicWriteFile(config.secretsFile, serializeConfigJson(next));
  secretsCache = next;
}

registerConfigStore({
  id: "proxy:secrets",
  files: () => [config.secretsFile],
  reset: () => {
    secretsCache = null;
  },
});

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
  secretsCache = null;
}
