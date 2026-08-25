import { BUILD_HOST_FACT_KEYS } from "@arriero/core";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  getArgumentDefaults,
  saveArgumentDefaults,
} from "./arguments/defaults-repository.js";
import { seedBuildHostFactsFromLegacySettings } from "./build/repository.js";
import { config } from "./config.js";
import { hasPortablePathCandidate } from "./config-paths.js";
import {
  ENVIRONMENTS_FILE,
  environmentRowsHaveMachineKeys,
  rewriteEnvironmentsFile,
} from "./envs/repository.js";
import {
  MODEL_REQUIREMENTS_FILE,
  rewriteModelRequirementsFile,
} from "./hf/requirements.js";
import { logger } from "./logger.js";
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
  poolDeclarationCarriesAutoCapacityValue,
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

function poolDeclarationsCarryAutoCapacityValues(json: unknown): boolean {
  return (
    Array.isArray(json) && json.some(poolDeclarationCarriesAutoCapacityValue)
  );
}

function settingsBuildSectionHasHostFacts(json: unknown): boolean {
  if (typeof json !== "object" || json === null) {
    return false;
  }
  const build = (json as { build?: unknown }).build;
  return (
    typeof build === "object" &&
    build !== null &&
    BUILD_HOST_FACT_KEYS.some((key) => Object.hasOwn(build, key))
  );
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

type StaleCheck = {
  portable: boolean;
  extraStale?: (json: unknown) => boolean;
};

function fileIsStale(path: string, check: StaleCheck): boolean {
  const json = readJsonFile(path);
  if (json === undefined) {
    return false;
  }
  if (check.portable && hasPortablePathCandidate(json)) {
    return true;
  }
  return check.extraStale?.(json) ?? false;
}

const collectionCheck: StaleCheck = {
  portable: false,
  extraStale: collectionHasTimestampKeys,
};

export function normalizeConfigFiles(): string[] {
  const rewritten: string[] = [];
  const track = (path: string) => {
    rewritten.push(relative(config.configDir, path));
  };
  const guard = (path: string, rewrite: () => void) => {
    try {
      rewrite();
    } catch (error) {
      logger.error(
        { error, path: relative(config.configDir, path) },
        "config file normalization skipped",
      );
    }
  };
  const normalize = (path: string, check: StaleCheck, rewrite: () => void) => {
    if (!fileIsStale(path, check)) {
      return;
    }
    guard(path, () => {
      rewrite();
      track(path);
    });
  };

  const singleFileRewrites: [string, StaleCheck, () => void][] = [
    [
      config.settingsFile,
      {
        portable: true,
        extraStale: (json) =>
          settingsHasTimestampKeys(json) ||
          settingsBuildSectionHasHostFacts(json),
      },
      () => {
        seedBuildHostFactsFromLegacySettings();
        writeSettings(readSettings());
      },
    ],
    [
      config.argumentDefaultsFile,
      { portable: true },
      () => saveArgumentDefaults(getArgumentDefaults()),
    ],
    [
      PATH_CATALOG_FILE,
      { portable: true },
      () => seedPathCatalog(listPathCatalogEntries()),
    ],
    [
      resolve(config.proxyConfigDir, ENDPOINTS_FILE),
      collectionCheck,
      rewriteStoredEndpoints,
    ],
    [
      resolve(config.proxyConfigDir, SOURCES_FILE),
      collectionCheck,
      rewriteStoredSources,
    ],
    [NODES_FILE, collectionCheck, rewriteNodesFile],
    [
      RESOURCES_FILE,
      {
        portable: false,
        extraStale: (json) =>
          collectionHasTimestampKeys(json) ||
          poolDeclarationsCarryAutoCapacityValues(json),
      },
      rewriteResourcePoolsFile,
    ],
    [
      ENVIRONMENTS_FILE,
      { portable: false, extraStale: environmentRowsHaveMachineKeys },
      rewriteEnvironmentsFile,
    ],
    [MODEL_REQUIREMENTS_FILE, { portable: true }, rewriteModelRequirementsFile],
  ];
  for (const [path, check, rewrite] of singleFileRewrites) {
    normalize(path, check, rewrite);
  }

  if (existsSync(config.instancesDir)) {
    for (const entry of readdirSync(config.instancesDir, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = resolve(config.instancesDir, entry.name);
      if (
        !fileIsStale(path, { portable: true, extraStale: hasTimestampKeys })
      ) {
        continue;
      }
      guard(path, () => {
        const record = getInstanceRecord(entry.name.slice(0, -".json".length));
        if (record) {
          writeInstanceRecord(record);
          track(path);
        }
      });
    }
  }

  const staleProxyCollections = [
    TARGETS_FILE,
    MODELS_FILE,
    PIPELINES_FILE,
  ].filter((name) =>
    fileIsStale(resolve(config.proxyConfigDir, name), collectionCheck),
  );
  if (staleProxyCollections.length > 0) {
    guard(resolve(config.proxyConfigDir, TARGETS_FILE), () => {
      rewriteApiProxyCollections(staleProxyCollections);
      for (const name of staleProxyCollections) {
        track(resolve(config.proxyConfigDir, name));
      }
    });
  }

  return rewritten;
}
