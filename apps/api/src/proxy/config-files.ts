import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { config } from "../config.js";
import { CONFIG_GITIGNORE_CONTENT } from "../config-git/machine-state.js";
import { ConfigFileError } from "../config-store/errors.js";
import {
  createJsonFileStore,
  fileMtimeMs,
  parseConfigJson,
  serializeConfigJson,
  type JsonFileStore,
} from "../config-store/file-store.js";
import { registerConfigStore } from "../config-store/registry.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const stores = new Map<string, JsonFileStore<unknown>>();
let secretsCache: Record<string, string> | null = null;
let secretsLoaded: { mtimeMs: number | null } | null = null;
let secretsQuarantine: ConfigFileError | null = null;

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
  if (secretsQuarantine) {
    throw secretsQuarantine;
  }
  if (secretsCache) {
    return secretsCache;
  }
  const mtimeMs = fileMtimeMs(config.secretsFile);
  if (mtimeMs !== null) {
    let json: unknown;
    try {
      json = parseConfigJson(
        config.secretsFile,
        readFileSync(config.secretsFile, "utf8"),
      );
    } catch (error) {
      if (error instanceof ConfigFileError) {
        secretsQuarantine = error;
      }
      throw error;
    }
    const parsed = z.record(z.string(), z.string()).safeParse(json);
    secretsCache = parsed.success ? parsed.data : {};
  } else {
    secretsCache = {};
  }
  secretsLoaded = { mtimeMs };
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
  secretsLoaded = { mtimeMs: fileMtimeMs(config.secretsFile) };
  secretsQuarantine = null;
}

registerConfigStore({
  id: "proxy:secrets",
  files: () => [config.secretsFile],
  init: () => {
    loadSecrets();
  },
  reset: () => {
    secretsCache = null;
    secretsLoaded = null;
    secretsQuarantine = null;
  },
  status: () => {
    const diskMtimeMs = fileMtimeMs(config.secretsFile);
    return [
      {
        storeId: "proxy:secrets",
        path: config.secretsFile,
        cacheMode: "process",
        exists: diskMtimeMs !== null,
        diskMtimeMs,
        loadedMtimeMs: secretsLoaded?.mtimeMs ?? null,
        dirtyOnDisk: secretsLoaded
          ? diskMtimeMs !== secretsLoaded.mtimeMs
          : null,
        error: secretsQuarantine?.message ?? null,
      },
    ];
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
  secretsLoaded = null;
  secretsQuarantine = null;
}
