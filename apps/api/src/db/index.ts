import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import * as schema from "./schema.js";

const databasePath = resolve(config.dataDir, "arriero.db");
const legacyDatabasePath = resolve(config.dataDir, "llama-manager.db");
if (!existsSync(databasePath) && existsSync(legacyDatabasePath)) {
  renameSync(legacyDatabasePath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${legacyDatabasePath}${suffix}`)) {
      renameSync(`${legacyDatabasePath}${suffix}`, `${databasePath}${suffix}`);
    }
  }
}

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

function ensureColumn(table: string, column: string, definition: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrate() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS process_runs (
      id TEXT PRIMARY KEY NOT NULL,
      instance_id TEXT NOT NULL,
      pid TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      exit_code TEXT,
      log_path TEXT NOT NULL,
      raw_log_path TEXT,
      launch_snapshot TEXT,
      adopted TEXT
    )
  `);
  ensureColumn("process_runs", "launch_snapshot", "TEXT");
  ensureColumn("process_runs", "adopted", "TEXT");

  db.run(sql`
    CREATE TABLE IF NOT EXISTS model_cache (
      path TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      size_bytes TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      is_mmproj TEXT NOT NULL,
      mmproj_paths_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      parser_version INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      scanned_at TEXT NOT NULL
    )
  `);
  ensureColumn("model_cache", "parser_version", "INTEGER NOT NULL DEFAULT 0");

  db.run(sql`
    CREATE TABLE IF NOT EXISTS llama_argument_catalogs (
      binary_path TEXT PRIMARY KEY NOT NULL,
      binary_size TEXT NOT NULL,
      binary_mtime_ms TEXT NOT NULL,
      binary_modified_at TEXT NOT NULL,
      help_hash TEXT NOT NULL,
      options_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      parser_id TEXT NOT NULL DEFAULT 'llama-help'
    )
  `);
  ensureColumn(
    "llama_argument_catalogs",
    "parser_id",
    "TEXT NOT NULL DEFAULT 'llama-help'",
  );

  db.run(sql`
    CREATE TABLE IF NOT EXISTS proxy_request_traces (
      id TEXT PRIMARY KEY NOT NULL,
      at TEXT NOT NULL,
      protocol TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source_id TEXT,
      target_id TEXT,
      status INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error_code TEXT,
      cache TEXT,
      resumed INTEGER NOT NULL,
      stream INTEGER,
      translated INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      trace_json TEXT NOT NULL
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS proxy_request_traces_at ON proxy_request_traces (at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS proxy_request_traces_model_at ON proxy_request_traces (model_id, at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS proxy_request_traces_source_at ON proxy_request_traces (source_id, at)`,
  );

  db.run(sql`
    CREATE TABLE IF NOT EXISTS proxy_response_cache (
      key TEXT PRIMARY KEY NOT NULL,
      model_id TEXT NOT NULL,
      status INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      is_sse INTEGER NOT NULL,
      body TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_access_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS proxy_response_cache_lru ON proxy_response_cache (last_access_at)`,
  );

  db.run(sql`DROP TABLE IF EXISTS llama_argument_help_overrides`);
}
