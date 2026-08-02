import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  getArgumentDefaults,
  saveArgumentDefaults,
} from "./arguments/defaults-repository.js";
import { config } from "./config.js";
import { hasPortablePathCandidate } from "./config-paths.js";
import {
  getInstanceRecord,
  writeInstanceRecord,
} from "./instances/config-files.js";
import { NODES_FILE, rewriteNodesFile } from "./nodes/repository.js";
import {
  PATH_CATALOG_FILE,
  listPathCatalogEntries,
  seedPathCatalog,
} from "./path-catalog/repository.js";
import { ENDPOINTS_FILE, rewriteStoredEndpoints } from "./proxy/endpoints.js";
import {
  MODELS_FILE,
  PIPELINES_FILE,
  TARGETS_FILE,
  rewriteApiProxyCollections,
} from "./proxy/repository.js";
import { SOURCES_FILE, rewriteStoredSources } from "./proxy/sources.js";
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

function fileIsStale(
  path: string,
  extraStale?: (json: unknown) => boolean,
): boolean {
  const json = readJsonFile(path);
  return (
    json !== undefined &&
    (hasPortablePathCandidate(json) || (extraStale?.(json) ?? false))
  );
}

export function normalizeConfigFiles(): string[] {
  const rewritten: string[] = [];
  const track = (path: string) => {
    rewritten.push(relative(config.configDir, path));
  };

  if (fileIsStale(config.settingsFile, settingsHasTimestampKeys)) {
    writeSettings(readSettings());
    track(config.settingsFile);
  }
  if (fileIsStale(config.argumentDefaultsFile)) {
    saveArgumentDefaults(getArgumentDefaults());
    track(config.argumentDefaultsFile);
  }
  if (fileIsStale(PATH_CATALOG_FILE)) {
    seedPathCatalog(listPathCatalogEntries());
    track(PATH_CATALOG_FILE);
  }
  if (existsSync(config.instancesDir)) {
    for (const entry of readdirSync(config.instancesDir, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = resolve(config.instancesDir, entry.name);
      if (!fileIsStale(path, hasTimestampKeys)) {
        continue;
      }
      const record = getInstanceRecord(entry.name.slice(0, -".json".length));
      if (record) {
        writeInstanceRecord(record);
        track(path);
      }
    }
  }

  const staleProxyCollections = [
    TARGETS_FILE,
    MODELS_FILE,
    PIPELINES_FILE,
  ].filter((name) =>
    fileIsStale(
      resolve(config.proxyConfigDir, name),
      collectionHasTimestampKeys,
    ),
  );
  if (staleProxyCollections.length > 0) {
    rewriteApiProxyCollections(staleProxyCollections);
    for (const name of staleProxyCollections) {
      track(resolve(config.proxyConfigDir, name));
    }
  }
  const endpointsPath = resolve(config.proxyConfigDir, ENDPOINTS_FILE);
  if (fileIsStale(endpointsPath, collectionHasTimestampKeys)) {
    rewriteStoredEndpoints();
    track(endpointsPath);
  }
  const sourcesPath = resolve(config.proxyConfigDir, SOURCES_FILE);
  if (fileIsStale(sourcesPath, collectionHasTimestampKeys)) {
    rewriteStoredSources();
    track(sourcesPath);
  }
  if (fileIsStale(NODES_FILE, collectionHasTimestampKeys)) {
    rewriteNodesFile();
    track(NODES_FILE);
  }
  if (fileIsStale(RESOURCES_FILE, collectionHasTimestampKeys)) {
    rewriteResourcePoolsFile();
    track(RESOURCES_FILE);
  }

  return rewritten;
}
