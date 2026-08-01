import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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

export const proxyRequestTraces = sqliteTable("proxy_request_traces", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  protocol: text("protocol").notNull(),
  endpoint: text("endpoint").notNull(),
  modelId: text("model_id").notNull(),
  sourceId: text("source_id"),
  sourceName: text("source_name"),
  targetId: text("target_id"),
  targetName: text("target_name"),
  status: integer("status").notNull(),
  ok: integer("ok").notNull(),
  errorCode: text("error_code"),
  cache: text("cache"),
  resumed: integer("resumed").notNull(),
  stream: integer("stream"),
  translated: integer("translated").notNull(),
  durationMs: integer("duration_ms").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  fileKinds: text("file_kinds").notNull().default("[]"),
  traceJson: text("trace_json").notNull(),
});

export const systemMetricsHistory = sqliteTable(
  "system_metrics_history",
  {
    window: text("window").notNull(),
    bucketAt: integer("bucket_at").notNull(),
    sampleJson: text("sample_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.window, table.bucketAt] })],
);

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
