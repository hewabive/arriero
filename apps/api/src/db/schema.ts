import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const processRuns = sqliteTable("process_runs", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  pid: text("pid"),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  stoppedAt: text("stopped_at"),
  exitCode: text("exit_code"),
  logPath: text("log_path").notNull(),
  rawLogPath: text("raw_log_path"),
  launchSnapshot: text("launch_snapshot"),
  adopted: text("adopted"),
});

export const modelCache = sqliteTable("model_cache", {
  path: text("path").primaryKey(),
  name: text("name").notNull(),
  directory: text("directory").notNull(),
  sizeBytes: text("size_bytes").notNull(),
  modifiedAt: text("modified_at").notNull(),
  isMmproj: text("is_mmproj").notNull(),
  mmprojPathsJson: text("mmproj_paths_json").notNull(),
  metadataJson: text("metadata_json").notNull(),
  parserVersion: integer("parser_version").notNull().default(0),
  error: text("error"),
  scannedAt: text("scanned_at").notNull(),
});

export const llamaArgumentCatalogs = sqliteTable("llama_argument_catalogs", {
  binaryPath: text("binary_path").primaryKey(),
  binarySize: text("binary_size").notNull(),
  binaryMtimeMs: text("binary_mtime_ms").notNull(),
  binaryModifiedAt: text("binary_modified_at").notNull(),
  helpHash: text("help_hash").notNull(),
  optionsJson: text("options_json").notNull(),
  generatedAt: text("generated_at").notNull(),
  parserId: text("parser_id").notNull().default("llama-help"),
});

export const apiProxyResponseCache = sqliteTable("proxy_response_cache", {
  key: text("key").primaryKey(),
  modelId: text("model_id").notNull(),
  status: integer("status").notNull(),
  contentType: text("content_type").notNull(),
  isSse: integer("is_sse").notNull(),
  body: text("body").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
  lastAccessAt: integer("last_access_at").notNull(),
  hitCount: integer("hit_count").notNull().default(0),
});
