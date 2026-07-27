import {
  ApiProxyModelRecordSchema,
  ApiProxyPipelineRecordSchema,
  ApiProxyRouteToSchema,
  ApiProxyTargetRecordSchema,
  upgradeLegacyApiProxyPipeline,
} from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { sqlite } from "../db/index.js";
import { writeCollection, setSecret } from "./config-files.js";
import { MODELS_FILE, PIPELINES_FILE, TARGETS_FILE } from "./repository.js";
import { ENDPOINTS_FILE, StoredEndpointSchema } from "./endpoints.js";

function tableExists(name: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

function parseBool(value: string) {
  return value === "true";
}

function parseSlotIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isInteger(item))
      : [];
  } catch {
    return [];
  }
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseRouteTo(value: string | null) {
  const parsed = ApiProxyRouteToSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : null;
}

function nullableNumber(value: string | null) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function exportIfAbsent(fileName: string, build: () => unknown[]) {
  if (existsSync(resolve(config.proxyConfigDir, fileName))) {
    return;
  }
  writeCollection(fileName, build());
}

function exportTargets() {
  exportIfAbsent(TARGETS_FILE, () =>
    (sqlite.prepare("SELECT * FROM api_proxy_targets").all() as any[]).map(
      (row) =>
        ApiProxyTargetRecordSchema.parse({
          id: row.id,
          name: row.name,
          endpointId: row.endpoint_id,
          model: row.model,
          role: row.role,
          priority: Number(row.priority),
          preemptible: parseBool(row.preemptible),
          saveSlotsBeforeUnload: parseBool(row.save_slots_before_unload),
          slotIds: parseSlotIds(row.slot_ids_json),
          idleUnloadMs: nullableNumber(row.idle_unload_ms),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
    ),
  );
}

function exportModels() {
  exportIfAbsent(MODELS_FILE, () =>
    (sqlite.prepare("SELECT * FROM api_proxy_models").all() as any[]).map(
      (row) =>
        ApiProxyModelRecordSchema.parse({
          id: row.id,
          modelId: row.model_id,
          visible: parseBool(row.enabled),
          enabled: true,
          ownedBy: row.owned_by,
          targetId: row.target_id,
          routeTo: parseRouteTo(row.route_to_json),
          description: row.description,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
    ),
  );
}

function exportPipelines() {
  exportIfAbsent(PIPELINES_FILE, () =>
    (sqlite.prepare("SELECT * FROM api_proxy_pipelines").all() as any[]).map(
      (row) =>
        ApiProxyPipelineRecordSchema.parse(
          upgradeLegacyApiProxyPipeline({
            id: row.id,
            name: row.name,
            enabled: parseBool(row.enabled),
            nodeType: row.node_type,
            steps: parseJson(row.steps_json) ?? [],
            routeTo: parseRouteTo(row.route_to_json),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }),
        ),
    ),
  );
}

function migrateLegacyAuth(row: any): {
  apiKeyEnvVar: string | null;
  authHeaderName: string | null;
} {
  const authType = String(row.auth_type ?? "none");
  const usesEnv =
    authType === "env-bearer" || authType === "env-api-key-header";
  const usesHeader =
    authType === "api-key-header" || authType === "env-api-key-header";
  return {
    apiKeyEnvVar: usesEnv ? (row.auth_env_var ?? null) : null,
    authHeaderName: usesHeader ? (row.auth_header_name ?? "x-api-key") : null,
  };
}

function exportEndpoints() {
  const rows = sqlite.prepare("SELECT * FROM api_endpoints").all() as any[];
  exportIfAbsent(ENDPOINTS_FILE, () =>
    rows.map((row) =>
      StoredEndpointSchema.parse({
        id: row.id,
        name: row.name,
        enabled: parseBool(row.enabled),
        baseUrl: row.base_url,
        profile: row.profile,
        ...migrateLegacyAuth(row),
        extraHeaders: {},
        passthrough: false,
        modelFilter: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    ),
  );
  for (const row of rows) {
    if (row.api_key) {
      setSecret(row.id, row.api_key);
    }
  }
}

function rebuildSchema() {
  sqlite.pragma("foreign_keys = OFF");
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE api_proxy_runtime_metadata_new (
        target_id TEXT PRIMARY KEY NOT NULL,
        saved_slot_ids_json TEXT NOT NULL,
        last_request_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO api_proxy_runtime_metadata_new
        SELECT target_id, saved_slot_ids_json, last_request_at, updated_at
        FROM api_proxy_runtime_metadata;
      DROP TABLE api_proxy_runtime_metadata;
      ALTER TABLE api_proxy_runtime_metadata_new
        RENAME TO api_proxy_runtime_metadata;
      DROP TABLE IF EXISTS api_proxy_models;
      DROP TABLE IF EXISTS api_proxy_pipelines;
      DROP TABLE IF EXISTS api_endpoints;
      DROP TABLE IF EXISTS api_proxy_targets;
    `);
  })();
  sqlite.pragma("foreign_keys = ON");
}

export function migrateProxyConfigToFiles(): boolean {
  if (!tableExists("api_proxy_targets")) {
    return false;
  }

  exportTargets();
  exportModels();
  exportPipelines();
  exportEndpoints();
  rebuildSchema();
  return true;
}
