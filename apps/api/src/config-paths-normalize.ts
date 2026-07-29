import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  getArgumentDefaults,
  saveArgumentDefaults,
} from "./arguments/defaults-repository.js";
import { config } from "./config.js";
import { hasPortablePathCandidate } from "./config-paths.js";
import {
  listInstanceRecords,
  writeInstanceRecord,
} from "./instances/config-files.js";
import {
  PATH_CATALOG_FILE,
  listPathCatalogEntries,
  seedPathCatalog,
} from "./path-catalog/repository.js";
import { readSettings, writeSettings } from "./settings/store.js";

function instanceConfigFiles(): string[] {
  if (!existsSync(config.instancesDir)) {
    return [];
  }
  return readdirSync(config.instancesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(config.instancesDir, entry.name));
}

function fileHasAbsolutePaths(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return false;
  }
  return hasPortablePathCandidate(json);
}

export function configFilesWithAbsolutePaths(): string[] {
  return [
    config.settingsFile,
    config.argumentDefaultsFile,
    PATH_CATALOG_FILE,
    ...instanceConfigFiles(),
  ]
    .filter(fileHasAbsolutePaths)
    .map((path) => relative(config.configDir, path));
}

export function normalizeConfigPaths(): string[] {
  const pending = configFilesWithAbsolutePaths();
  if (pending.length === 0) {
    return pending;
  }
  if (fileHasAbsolutePaths(config.settingsFile)) {
    writeSettings(readSettings());
  }
  if (fileHasAbsolutePaths(config.argumentDefaultsFile)) {
    saveArgumentDefaults(getArgumentDefaults());
  }
  if (fileHasAbsolutePaths(PATH_CATALOG_FILE)) {
    seedPathCatalog(listPathCatalogEntries());
  }
  for (const record of listInstanceRecords()) {
    if (
      fileHasAbsolutePaths(resolve(config.instancesDir, `${record.name}.json`))
    ) {
      writeInstanceRecord(record);
    }
  }
  return pending;
}
