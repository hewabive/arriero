import { existsSync, readFileSync } from "node:fs";
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
import { NODES_FILE, rewriteNodesFile } from "./nodes/repository.js";
import {
  PATH_CATALOG_FILE,
  listPathCatalogEntries,
  seedPathCatalog,
} from "./path-catalog/repository.js";
import {
  ENDPOINTS_FILE,
  rewriteStoredEndpoints,
} from "./proxy/endpoints.js";
import {
  MODELS_FILE,
  PIPELINES_FILE,
  TARGETS_FILE,
  rewriteApiProxyCollections,
} from "./proxy/repository.js";
import { rewriteStoredSources } from "./proxy/sources.js";
import {
  RESOURCES_FILE,
  rewriteResourcePoolsFile,
} from "./resources/repository.js";
import { readSettings, writeSettings } from "./settings/store.js";

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function hasTimestampKeys(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, "createdAt") || Object.hasOwn(value, "updatedAt"))
  );
}

function collectionHasTimestampKeys(json: unknown): boolean {
  return Array.isArray(json) && json.some(hasTimestampKeys);
}

function settingsHasTimestampKeys(json: unknown): boolean {
  if (typeof json !== "object" || json === null) {
    return false;
  }
  const settings = json as {
    sourceRepositories?: unknown;
    llamaSource?: unknown;
  };
  if (
    Array.isArray(settings.sourceRepositories) &&
    settings.sourceRepositories.some(hasTimestampKeys)
  ) {
    return true;
  }
  return hasTimestampKeys(settings.llamaSource);
}

function trackedCollectionIsStale(json: unknown): boolean {
  return hasPortablePathCandidate(json) || collectionHasTimestampKeys(json);
}

function fileIsStale(
  path: string,
  stale: (json: unknown) => boolean,
): boolean {
  const json = readJsonFile(path);
  return json !== undefined && stale(json);
}

export function normalizeConfigFiles(): string[] {
  const rewritten: string[] = [];
  const track = (path: string) => {
    rewritten.push(relative(config.configDir, path));
  };

  if (
    fileIsStale(
      config.settingsFile,
      (json) => hasPortablePathCandidate(json) || settingsHasTimestampKeys(json),
    )
  ) {
    writeSettings(readSettings());
    track(config.settingsFile);
  }
  if (fileIsStale(config.argumentDefaultsFile, hasPortablePathCandidate)) {
    saveArgumentDefaults(getArgumentDefaults());
    track(config.argumentDefaultsFile);
  }
  if (fileIsStale(PATH_CATALOG_FILE, hasPortablePathCandidate)) {
    seedPathCatalog(listPathCatalogEntries());
    track(PATH_CATALOG_FILE);
  }
  for (const record of listInstanceRecords()) {
    const path = resolve(config.instancesDir, `${record.name}.json`);
    if (
      fileIsStale(
        path,
        (json) => hasPortablePathCandidate(json) || hasTimestampKeys(json),
      )
    ) {
      writeInstanceRecord(record);
      track(path);
    }
  }

  const staleProxyCollections = [TARGETS_FILE, MODELS_FILE, PIPELINES_FILE]
    .map((name) => resolve(config.proxyConfigDir, name))
    .filter((path) => fileIsStale(path, trackedCollectionIsStale));
  if (staleProxyCollections.length > 0) {
    rewriteApiProxyCollections();
    staleProxyCollections.forEach(track);
  }
  const endpointsPath = resolve(config.proxyConfigDir, ENDPOINTS_FILE);
  if (fileIsStale(endpointsPath, trackedCollectionIsStale)) {
    rewriteStoredEndpoints();
    track(endpointsPath);
  }
  const sourcesPath = resolve(config.proxyConfigDir, "sources.json");
  if (fileIsStale(sourcesPath, trackedCollectionIsStale)) {
    rewriteStoredSources();
    track(sourcesPath);
  }
  if (fileIsStale(NODES_FILE, trackedCollectionIsStale)) {
    rewriteNodesFile();
    track(NODES_FILE);
  }
  if (fileIsStale(RESOURCES_FILE, trackedCollectionIsStale)) {
    rewriteResourcePoolsFile();
    track(RESOURCES_FILE);
  }

  return rewritten;
}
