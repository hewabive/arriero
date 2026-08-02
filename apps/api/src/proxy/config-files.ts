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
import { CONFIG_GITIGNORE_CONTENT } from "../config-git/machine-state.js";

const collectionCache = new Map<string, unknown[]>();
const objectCache = new Map<string, unknown>();
let secretsCache: Record<string, string> | null = null;

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function parseJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

export function readCollection<T>(fileName: string, schema: z.ZodType<T>): T[] {
  const cached = collectionCache.get(fileName);
  if (cached) {
    return cached as T[];
  }

  const path = resolve(config.proxyConfigDir, fileName);
  let records: T[] = [];
  if (existsSync(path)) {
    const parsed = z.array(schema).safeParse(parseJsonFile(path));
    if (!parsed.success) {
      throw new Error(`Invalid config in ${path}: ${parsed.error.message}`);
    }
    records = parsed.data;
  }

  collectionCache.set(fileName, records as unknown[]);
  return records;
}

export function writeCollection<T>(fileName: string, records: T[]): void {
  atomicWrite(
    resolve(config.proxyConfigDir, fileName),
    `${JSON.stringify(records, null, 2)}\n`,
  );
  collectionCache.set(fileName, records as unknown[]);
}

export function readObjectFile<T>(fileName: string, schema: z.ZodType<T>): T {
  if (objectCache.has(fileName)) {
    return objectCache.get(fileName) as T;
  }

  const path = resolve(config.proxyConfigDir, fileName);
  const parsed = schema.safeParse(existsSync(path) ? parseJsonFile(path) : {});
  if (!parsed.success) {
    throw new Error(`Invalid config in ${path}: ${parsed.error.message}`);
  }

  objectCache.set(fileName, parsed.data);
  return parsed.data;
}

export function writeObjectFile<T>(fileName: string, value: T): void {
  atomicWrite(
    resolve(config.proxyConfigDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  objectCache.set(fileName, value);
}

function loadSecrets(): Record<string, string> {
  if (secretsCache) {
    return secretsCache;
  }
  if (existsSync(config.secretsFile)) {
    const parsed = z
      .record(z.string(), z.string())
      .safeParse(parseJsonFile(config.secretsFile));
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
  atomicWrite(config.secretsFile, `${JSON.stringify(next, null, 2)}\n`);
  secretsCache = next;
}

export function ensureConfigScaffold(): void {
  mkdirSync(config.proxyConfigDir, { recursive: true });
  if (!existsSync(config.configGitignoreFile)) {
    writeFileSync(config.configGitignoreFile, CONFIG_GITIGNORE_CONTENT, "utf8");
  }
}

export function resetConfigFilesCache(): void {
  collectionCache.clear();
  objectCache.clear();
  secretsCache = null;
}
