import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { sqlite } from "../db/index.js";
import { readSecret, resetConfigFilesCache } from "./config-files.js";
import { migrateProxyConfigToFiles } from "./legacy-migration.js";
import { getExternalApiEndpoint } from "./endpoints.js";

function dropLegacyTables() {
  sqlite.exec(`
    DROP TABLE IF EXISTS api_proxy_models;
    DROP TABLE IF EXISTS api_proxy_pipelines;
    DROP TABLE IF EXISTS api_endpoints;
    DROP TABLE IF EXISTS api_proxy_targets;
  `);
}

function tableNames(): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function seedLegacyDb() {
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`
    CREATE TABLE api_proxy_targets (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, enabled TEXT NOT NULL,
      endpoint_id TEXT NOT NULL, model TEXT, role TEXT NOT NULL,
      priority TEXT NOT NULL, resource_group_id TEXT, preemptible TEXT NOT NULL,
      save_slots_before_unload TEXT NOT NULL, slot_ids_json TEXT NOT NULL,
      idle_unload_ms TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE api_proxy_models (
      id TEXT PRIMARY KEY NOT NULL, model_id TEXT NOT NULL UNIQUE,
      enabled TEXT NOT NULL, owned_by TEXT NOT NULL, target_id TEXT,
      route_to_json TEXT, description TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE api_proxy_pipelines (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, enabled TEXT NOT NULL,
      node_type TEXT NOT NULL DEFAULT 'replace-text', steps_json TEXT NOT NULL,
      route_to_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE api_endpoints (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, enabled TEXT NOT NULL,
      base_url TEXT NOT NULL, profile TEXT NOT NULL, auth_type TEXT NOT NULL,
      auth_header_name TEXT, auth_env_var TEXT, api_key TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    DROP TABLE IF EXISTS api_proxy_runtime_metadata;
    CREATE TABLE api_proxy_runtime_metadata (
      target_id TEXT PRIMARY KEY NOT NULL
        REFERENCES api_proxy_targets(id) ON DELETE CASCADE,
      saved_slot_ids_json TEXT NOT NULL, last_request_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.pragma("foreign_keys = ON");

  const ts = "2026-01-01T00:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO api_proxy_targets VALUES
       ('t1','big','true','instance:i1',NULL,'background','100','gpu0','true','true','[0]',NULL,?,?)`,
    )
    .run(ts, ts);
  sqlite
    .prepare(
      `INSERT INTO api_proxy_models VALUES ('m1','big-slow','true','arriero','t1',NULL,NULL,?,?)`,
    )
    .run(ts, ts);
  sqlite
    .prepare(
      `INSERT INTO api_proxy_pipelines VALUES ('p1','clean','true','replace-text','[]',NULL,?,?)`,
    )
    .run(ts, ts);
  sqlite
    .prepare(
      `INSERT INTO api_endpoints VALUES ('e1','vendor','true','https://api.vendor.com/v1','openai','bearer',NULL,NULL,'sk-legacy-key',?,?)`,
    )
    .run(ts, ts);
  sqlite
    .prepare(
      `INSERT INTO api_proxy_runtime_metadata VALUES ('t1','[2]',NULL,?)`,
    )
    .run(ts);
}

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

test("exports legacy proxy tables to files and rebuilds schema", () => {
  seedLegacyDb();

  assert.equal(migrateProxyConfigToFiles(), true);

  const targets = JSON.parse(
    readFileSync(`${config.proxyConfigDir}/targets.json`, "utf8"),
  ) as Array<{ id: string; slotIds: number[] }>;
  assert.equal(targets[0]?.id, "t1");
  assert.deepEqual(targets[0]?.slotIds, [0]);

  const models = JSON.parse(
    readFileSync(`${config.proxyConfigDir}/models.json`, "utf8"),
  ) as Array<{
    modelId: string;
    targetId: string | null;
    visible: boolean;
    enabled: boolean;
  }>;
  assert.equal(models[0]?.modelId, "big-slow");
  assert.equal(models[0]?.targetId, "t1");
  assert.equal(models[0]?.visible, true);
  assert.equal(models[0]?.enabled, true);

  const rawEndpoints = readFileSync(
    `${config.proxyConfigDir}/endpoints.json`,
    "utf8",
  );
  assert.ok(!rawEndpoints.includes("sk-legacy-key"));
  assert.equal(readSecret("e1"), "sk-legacy-key");
  assert.equal(getExternalApiEndpoint("e1")?.authConfigured, true);

  const tables = tableNames();
  for (const dropped of [
    "api_proxy_targets",
    "api_proxy_models",
    "api_proxy_pipelines",
    "api_endpoints",
  ]) {
    assert.ok(!tables.includes(dropped), `${dropped} should be dropped`);
  }
  assert.ok(tables.includes("api_proxy_runtime_metadata"));

  const runtimeRow = sqlite
    .prepare(
      "SELECT saved_slot_ids_json FROM api_proxy_runtime_metadata WHERE target_id = 't1'",
    )
    .get() as { saved_slot_ids_json: string } | undefined;
  assert.equal(runtimeRow?.saved_slot_ids_json, "[2]");
});

test("is idempotent when legacy tables are absent", () => {
  dropLegacyTables();
  assert.equal(migrateProxyConfigToFiles(), false);
});
