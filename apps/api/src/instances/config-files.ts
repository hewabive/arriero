import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  InstanceConfigRecordSchema,
  type InstanceConfigRecord,
} from "@arriero/core";

import { config } from "../config.js";
import { fromPortableConfig, toPortableConfig } from "../config-paths.js";

const instancesDir = config.instancesDir;

let cache: Map<string, InstanceConfigRecord> | null = null;

function recordPath(name: string): string {
  return resolve(instancesDir, `${name}.json`);
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function parseJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function load(): Map<string, InstanceConfigRecord> {
  if (cache) {
    return cache;
  }
  const next = new Map<string, InstanceConfigRecord>();
  if (existsSync(instancesDir)) {
    for (const entry of readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = resolve(instancesDir, entry.name);
      const parsed = InstanceConfigRecordSchema.safeParse(
        fromPortableConfig(parseJsonFile(path)),
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid instance config in ${path}: ${parsed.error.message}`,
        );
      }
      next.set(parsed.data.name, parsed.data);
    }
  }
  cache = next;
  return next;
}

export function listInstanceRecords(): InstanceConfigRecord[] {
  return [...load().values()];
}

export function getInstanceRecord(name: string): InstanceConfigRecord | null {
  return load().get(name) ?? null;
}

export function findInstanceRecordByName(
  name: string,
): InstanceConfigRecord | null {
  return load().get(name) ?? null;
}

export function writeInstanceRecord(
  record: InstanceConfigRecord,
  previousName?: string,
): void {
  const parsed = InstanceConfigRecordSchema.parse(record);
  const validated = {
    ...parsed,
    args: sortedRecord(parsed.args),
    env: sortedRecord(parsed.env),
  };
  const map = load();
  atomicWrite(
    recordPath(validated.name),
    `${JSON.stringify(toPortableConfig(validated), null, 2)}\n`,
  );
  if (previousName && previousName !== validated.name) {
    const previousPath = recordPath(previousName);
    if (existsSync(previousPath)) {
      unlinkSync(previousPath);
    }
    map.delete(previousName);
  }
  map.set(validated.name, validated);
}

export function removeInstanceRecord(name: string): boolean {
  const map = load();
  const record = map.get(name);
  if (!record) {
    return false;
  }
  const path = recordPath(record.name);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  map.delete(name);
  return true;
}

export function resetInstancesCache(): void {
  cache = null;
}
