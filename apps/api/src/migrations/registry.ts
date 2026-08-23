import {
  argumentDefaultsHasPresetSection,
  dropPresetArgumentDefaultsSection,
} from "../arguments/preset-defaults-migration.js";
import {
  hasLegacyConfigFiles,
  relocateLegacyConfigFiles,
} from "../config-relocation.js";
import { sqlite } from "../db/index.js";
import {
  instanceConfigsHaveLegacyNumaNode,
  migrateInstanceNumaNodeToNuma,
} from "../instances/numa-migration.js";
import { migratePathCatalogToFile } from "../path-catalog/migration.js";
import { migrateProxyConfigToFiles } from "../proxy/legacy-migration.js";
import {
  hasLegacyPipelineRecords,
  migratePipelinesToGraphFormat,
} from "../proxy/pipelines-graph-migration.js";
import {
  hasLegacyModelVisibility,
  migrateModelVisibility,
} from "../proxy/models-visibility-migration.js";
import {
  dropStoredRemoteInstanceEndpoints,
  storedEndpointsHaveRemoteInstances,
} from "../proxy/remote-endpoint-migration.js";
import {
  migrateStoredEndpointsAuth,
  storedEndpointsHaveLegacyAuth,
} from "../proxy/endpoints-auth-migration.js";
import {
  migrateModelReasoningToUpstreams,
  modelsFileHasReasoningOverrides,
} from "../proxy/model-reasoning-migration.js";
import { migrateApiProxyRuntimeMetadataToFile } from "../proxy/runtime-metadata-migration.js";
import {
  dropPresetsSettingsSection,
  settingsFileHasPresetsSection,
} from "../settings/presets-settings-migration.js";
import type { Migration } from "./types.js";

function tableExists(name: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

export const migrations: Migration[] = [
  {
    id: "0001-relocate-legacy-config-files",
    describe:
      "data/{settings.json,argument-defaults.json,presets/} → data/config/",
    isApplied: () => !hasLegacyConfigFiles(),
    apply: () => {
      relocateLegacyConfigFiles();
    },
  },
  {
    id: "0002-proxy-config-to-files",
    describe: "SQLite api_proxy_* / api_endpoints → config/proxy/*.json",
    isApplied: () => !tableExists("api_proxy_targets"),
    apply: () => {
      migrateProxyConfigToFiles();
    },
  },
  {
    id: "0003-proxy-runtime-metadata-to-file",
    describe:
      "SQLite api_proxy_runtime_metadata → data/proxy-runtime-metadata.json",
    isApplied: () => !tableExists("api_proxy_runtime_metadata"),
    apply: () => {
      migrateApiProxyRuntimeMetadataToFile();
    },
  },
  {
    id: "0004-path-catalog-to-file",
    describe: "SQLite path_catalog → data/config/path-catalog.json",
    isApplied: () => !tableExists("path_catalog"),
    apply: () => {
      migratePathCatalogToFile();
    },
  },
  {
    id: "0005-pipelines-graph-format",
    describe: "config/proxy/pipelines.json legacy steps/routeTo → node graph",
    isApplied: () => !hasLegacyPipelineRecords(),
    apply: () => {
      migratePipelinesToGraphFormat();
    },
  },
  {
    id: "0006-drop-presets-settings",
    describe:
      "settings.json: remove obsolete presets section (validation binary)",
    isApplied: () => !settingsFileHasPresetsSection(),
    apply: () => {
      dropPresetsSettingsSection();
    },
  },
  {
    id: "0007-drop-preset-argument-defaults",
    describe:
      "argument-defaults.json: remove obsolete preset scope (presets edited as raw INI)",
    isApplied: () => !argumentDefaultsHasPresetSection(),
    apply: () => {
      dropPresetArgumentDefaultsSection();
    },
  },
  {
    id: "0008-instance-numa-node-to-numa",
    describe: "config/instances/*.json: numaNode → numa { mode: bind, node }",
    isApplied: () => !instanceConfigsHaveLegacyNumaNode(),
    apply: () => {
      migrateInstanceNumaNodeToNuma();
    },
  },
  {
    id: "0009-drop-stored-remote-endpoints",
    describe:
      "config/proxy/endpoints.json: drop stored remote-instance endpoints (now resolved by id)",
    isApplied: () => !storedEndpointsHaveRemoteInstances(),
    apply: () => {
      dropStoredRemoteInstanceEndpoints();
    },
  },
  {
    id: "0010-proxy-model-visible-enabled",
    describe:
      "config/proxy/models.json: enabled (visibility) → visible; new enabled = serving",
    isApplied: () => !hasLegacyModelVisibility(),
    apply: () => {
      migrateModelVisibility();
    },
  },
  {
    id: "0011-endpoint-auth-simplify",
    describe:
      "config/proxy/endpoints.json: authType enum → apiKeyEnvVar + authHeaderName + extraHeaders",
    isApplied: () => !storedEndpointsHaveLegacyAuth(),
    apply: () => {
      migrateStoredEndpointsAuth();
    },
  },
  {
    id: "0012-model-reasoning-to-upstreams",
    describe:
      "config/proxy/models.json reasoning → instance/endpoint reasoning override",
    isApplied: () => !modelsFileHasReasoningOverrides(),
    apply: () => {
      migrateModelReasoningToUpstreams();
    },
  },
];
