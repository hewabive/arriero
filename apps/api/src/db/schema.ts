import type { ProcessStopReason, WebappStopReason } from "@arriero/core";
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
  stopReason: text("stop_reason").$type<ProcessStopReason>(),
});

export const webappRuns = sqliteTable("webapp_runs", {
  id: text("id").primaryKey(),
  webappId: text("webapp_id").notNull(),
  pid: text("pid"),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  stoppedAt: text("stopped_at"),
  exitCode: text("exit_code"),
  logPath: text("log_path").notNull(),
  rawLogPath: text("raw_log_path"),
  launchSnapshot: text("launch_snapshot"),
  adopted: text("adopted"),
  stopReason: text("stop_reason").$type<WebappStopReason>(),
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
  rawJson: text("raw_json"),
  rawVersion: integer("raw_version").notNull().default(0),
  error: text("error"),
  scannedAt: text("scanned_at").notNull(),
});

export const safetensorsCache = sqliteTable("safetensors_cache", {
  path: text("path").primaryKey(),
  name: text("name").notNull(),
  directory: text("directory").notNull(),
  sizeBytes: text("size_bytes").notNull(),
  modifiedAt: text("modified_at").notNull(),
  weightFilesJson: text("weight_files_json").notNull(),
  missingShardsJson: text("missing_shards_json").notNull(),
  metadataJson: text("metadata_json").notNull(),
  parserVersion: integer("parser_version").notNull().default(0),
  rawJson: text("raw_json"),
  rawVersion: integer("raw_version").notNull().default(0),
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

export const memoryAssessments = sqliteTable("memory_assessments", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id"),
  receiptJson: text("receipt_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at"),
  instanceId: text("instance_id").notNull(),
  label: text("label"),
  scenarioJson: text("scenario_json").notNull(),
  snapshotJson: text("snapshot_json"),
  warningsJson: text("warnings_json").notNull(),
  summaryJson: text("summary_json"),
  error: text("error"),
});

export const workloadRecords = sqliteTable("workload_records", {
  traceId: text("trace_id").primaryKey(),
  at: text("at").notNull(),
  endAt: text("end_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  sourceId: text("source_id"),
  sourceName: text("source_name"),
  modelId: text("model_id").notNull(),
  targetId: text("target_id"),
  targetName: text("target_name"),
  protocol: text("protocol").notNull(),
  endpoint: text("endpoint").notNull(),
  outcome: text("outcome").notNull(),
  issue: text("issue"),
  capturePath: text("capture_path"),
  messageCount: integer("message_count"),
  chainKey: text("chain_key"),
  sessionId: text("session_id").notNull(),
  parentTraceId: text("parent_trace_id"),
  sharedMessages: integer("shared_messages"),
  clientSessionId: text("client_session_id"),
  promptTokens: integer("prompt_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  completionTokens: integer("completion_tokens"),
  ttftMs: integer("ttft_ms"),
  thinkTimeMs: integer("think_time_ms"),
  cacheLossTokens: integer("cache_loss_tokens"),
  responseReuseTokens: integer("response_reuse_tokens"),
  normalizationVersion: integer("normalization_version").notNull(),
});

export const workloadIndexState = sqliteTable("workload_index_state", {
  id: integer("id").primaryKey(),
  normalizationVersion: integer("normalization_version").notNull(),
  lastPassAt: text("last_pass_at"),
  lastPassIndexed: integer("last_pass_indexed").notNull(),
});
