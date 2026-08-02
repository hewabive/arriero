import {
  ArgumentDefaultsSchema,
  type ArgumentDefault,
  type ArgumentDefaults,
} from "@arriero/core";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { config } from "../config.js";
import { fromPortableConfig, toPortableConfig } from "../config-paths.js";
import { sortedByKey } from "../utils/sort.js";

const filePath = config.argumentDefaultsFile;
const seedPath = config.argumentDefaultsSeedFile;

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
  writeFileSync(
    filePath,
    `${JSON.stringify({ instance: [] }, null, 2)}\n`,
    "utf8",
  );
}

function readDefaults(): ArgumentDefaults {
  const raw = readFileSync(filePath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
  return ArgumentDefaultsSchema.parse(fromPortableConfig(json));
}

function writeDefaults(input: { instance: ArgumentDefault[] }) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify(toPortableConfig(input), null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, filePath);
}

export function initArgumentDefaults() {
  ensureFile();
  readDefaults();
}

export function getArgumentDefaults(): ArgumentDefaults {
  ensureFile();
  const parsed = readDefaults();
  return ArgumentDefaultsSchema.parse({
    instance: parsed.instance,
    updatedAt: statSync(filePath).mtime.toISOString(),
  });
}

export function saveArgumentDefaults(
  input: ArgumentDefaults,
): ArgumentDefaults {
  const parsed = ArgumentDefaultsSchema.parse(input);
  writeDefaults({
    instance: normalizeDefaults(parsed.instance),
  });
  return getArgumentDefaults();
}
