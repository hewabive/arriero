import {
  ArgumentDefaultsSchema,
  type ArgumentDefault,
  type ArgumentDefaults,
} from "@arriero/core";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";

import { config } from "../config.js";
import {
  createJsonFileStore,
  serializeConfigJson,
} from "../config-store/file-store.js";
import { sortedByKey } from "../utils/sort.js";

const filePath = config.argumentDefaultsFile;
const seedPath = config.argumentDefaultsSeedFile;

const store = createJsonFileStore<ArgumentDefaults>({
  id: "argument-defaults",
  path: filePath,
  schema: ArgumentDefaultsSchema,
  missing: () => ({ instance: [] }),
  portablePaths: true,
  cache: "process",
  render: (value) => ({ instance: value.instance }),
});

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

function ensureFile() {
  if (existsSync(filePath)) {
    return;
  }
  if (existsSync(seedPath)) {
    copyFileSync(seedPath, filePath);
    return;
  }
  writeFileSync(filePath, serializeConfigJson({ instance: [] }), "utf8");
}

export function initArgumentDefaults() {
  ensureFile();
  store.read();
}

export function getArgumentDefaults(): ArgumentDefaults {
  ensureFile();
  const parsed = store.read();
  return ArgumentDefaultsSchema.parse({
    instance: parsed.instance,
    updatedAt: statSync(filePath).mtime.toISOString(),
  });
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
    updatedAt: null,
  });
  return getArgumentDefaults();
}
