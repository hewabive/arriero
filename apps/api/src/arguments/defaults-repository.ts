import {
  ArgumentDefaultsSchema,
  type ArgumentDefault,
  type ArgumentDefaults,
} from "@arriero/core";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import type { z } from "zod";

import { config } from "../config.js";
import {
  createJsonFileStore,
  fileMtimeMs,
  serializeConfigJson,
} from "../config-store/file-store.js";
import { sortedByKey } from "../utils/sort.js";

const filePath = config.argumentDefaultsFile;
const seedPath = config.argumentDefaultsSeedFile;

function ensureFile() {
  if (existsSync(filePath)) {
    return;
  }
  if (existsSync(seedPath)) {
    copyFileSync(seedPath, filePath);
    return;
  }
  writeFileSync(
    filePath,
    serializeConfigJson({ instance: [], engines: {} }),
    "utf8",
  );
}

const StoredArgumentDefaultsSchema = ArgumentDefaultsSchema.pick({
  instance: true,
  engines: true,
});

const store = createJsonFileStore<z.infer<typeof StoredArgumentDefaultsSchema>>(
  {
    id: "argument-defaults",
    path: filePath,
    schema: StoredArgumentDefaultsSchema,
    missing: () => ({ instance: [], engines: {} }),
    portablePaths: true,
    cache: "process",
    ensure: ensureFile,
  },
);

function normalizeDefaults(defaults: ArgumentDefault[]) {
  const seen = new Set<string>();
  const cleaned = defaults
    .map((item) => ({
      key: item.key.trim(),
      value: item.value.trim(),
      valueType: item.valueType,
    }))
    .filter((item) => {
      if (!item.key || seen.has(item.key)) {
        return false;
      }
      seen.add(item.key);
      return true;
    });
  return sortedByKey(cleaned, (item) => item.key);
}

function normalizeEngineDefaults(engines: ArgumentDefaults["engines"]) {
  const entries = Object.entries(engines)
    .map(
      ([engineId, defaults]) =>
        [engineId, normalizeDefaults(defaults)] as const,
    )
    .filter(([, defaults]) => defaults.length > 0);
  return Object.fromEntries(sortedByKey(entries, ([engineId]) => engineId));
}

export function getArgumentDefaults(): ArgumentDefaults {
  const stored = store.read();
  const mtimeMs = fileMtimeMs(filePath);
  return {
    instance: stored.instance,
    engines: stored.engines,
    updatedAt: mtimeMs !== null ? new Date(mtimeMs).toISOString() : null,
  };
}

export function resetArgumentDefaultsCache() {
  store.reset();
}

export function saveArgumentDefaults(
  input: ArgumentDefaults,
): ArgumentDefaults {
  const parsed = ArgumentDefaultsSchema.parse(input);
  store.write({
    instance: normalizeDefaults(parsed.instance),
    engines: normalizeEngineDefaults(parsed.engines),
  });
  return getArgumentDefaults();
}
