import {
  ApiProxyRequestTraceSchema,
  type ApiProxyRequestTrace,
  type ApiProxyTraceFacet,
  type ApiProxyTraceFacets,
  type ApiProxyTraceListFilter,
} from "@arriero/core";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { db } from "../db/index.js";
import { parsePersistedJson } from "../db/persisted-json.js";
import { startRetentionLoop } from "../db/retention.js";
import { proxyRequestTraces } from "../db/schema.js";
import { pruneApiProxyRequestFiles } from "./request-files.js";

const TRACE_RETENTION_DAYS = 30;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function retentionCutoff(now: Date): string {
  return new Date(
    now.getTime() - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function traceFileKinds(trace: ApiProxyRequestTrace): string {
  const kinds: string[] = [];
  for (const file of trace.files) {
    if (!kinds.includes(file.kind)) {
      kinds.push(file.kind);
    }
  }
  return JSON.stringify(kinds);
}

export function insertApiProxyTrace(trace: ApiProxyRequestTrace): void {
  db.insert(proxyRequestTraces)
    .values({
      id: trace.id,
      at: trace.at,
      protocol: trace.protocol,
      endpoint: trace.endpoint,
      modelId: trace.modelId,
      sourceId: trace.sourceId,
      sourceName: trace.sourceName,
      targetId: trace.targetId,
      targetName: trace.targetName,
      status: trace.status,
      ok: trace.ok ? 1 : 0,
      errorCode: trace.errorCode,
      cache: trace.cache,
      resumed: trace.resumed ? 1 : 0,
      stream: trace.stream === null ? null : trace.stream ? 1 : 0,
      translated: trace.translated ? 1 : 0,
      durationMs: trace.durationMs,
      promptTokens: trace.usage?.promptTokens ?? null,
      completionTokens: trace.usage?.completionTokens ?? null,
      fileKinds: traceFileKinds(trace),
      traceJson: JSON.stringify(trace),
    })
    .run();
}

function parseTraceRows(
  rows: Array<{ traceJson: string }>,
): ApiProxyRequestTrace[] {
  const traces: ApiProxyRequestTrace[] = [];
  for (const row of rows) {
    const trace = parsePersistedJson(ApiProxyRequestTraceSchema, row.traceJson);
    if (trace) {
      traces.push(trace);
    }
  }
  return traces;
}

function filterConditions(filter: ApiProxyTraceListFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.before !== undefined) {
    conditions.push(lt(proxyRequestTraces.at, filter.before));
  }
  if (filter.from !== undefined) {
    conditions.push(gte(proxyRequestTraces.at, filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push(lte(proxyRequestTraces.at, filter.to));
  }
  if (filter.protocol !== undefined) {
    conditions.push(eq(proxyRequestTraces.protocol, filter.protocol));
  }
  if (filter.endpoint !== undefined) {
    conditions.push(eq(proxyRequestTraces.endpoint, filter.endpoint));
  }
  if (filter.modelId !== undefined) {
    conditions.push(eq(proxyRequestTraces.modelId, filter.modelId));
  }
  if (filter.sourceId !== undefined) {
    conditions.push(eq(proxyRequestTraces.sourceId, filter.sourceId));
  }
  if (filter.targetId !== undefined) {
    conditions.push(eq(proxyRequestTraces.targetId, filter.targetId));
  }
  if (filter.ok !== undefined) {
    conditions.push(eq(proxyRequestTraces.ok, filter.ok ? 1 : 0));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(proxyRequestTraces.status, filter.status));
  }
  if (filter.errorCode !== undefined) {
    conditions.push(eq(proxyRequestTraces.errorCode, filter.errorCode));
  }
  if (filter.cache !== undefined) {
    conditions.push(
      filter.cache === "none"
        ? isNull(proxyRequestTraces.cache)
        : eq(proxyRequestTraces.cache, filter.cache),
    );
  }
  if (filter.resumed !== undefined) {
    conditions.push(eq(proxyRequestTraces.resumed, filter.resumed ? 1 : 0));
  }
  if (filter.stream !== undefined) {
    conditions.push(eq(proxyRequestTraces.stream, filter.stream ? 1 : 0));
  }
  if (filter.translated !== undefined) {
    conditions.push(
      eq(proxyRequestTraces.translated, filter.translated ? 1 : 0),
    );
  }
  if (filter.hasFiles !== undefined) {
    conditions.push(
      filter.hasFiles
        ? sql`json_array_length(${proxyRequestTraces.fileKinds}) > 0`
        : sql`json_array_length(${proxyRequestTraces.fileKinds}) = 0`,
    );
  }
  if (filter.fileKind !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(${proxyRequestTraces.fileKinds}) WHERE value = ${filter.fileKind})`,
    );
  }
  if (filter.minDurationMs !== undefined) {
    conditions.push(gte(proxyRequestTraces.durationMs, filter.minDurationMs));
  }
  return conditions;
}

export function getApiProxyTrace(id: string): ApiProxyRequestTrace | null {
  const rows = db
    .select({ traceJson: proxyRequestTraces.traceJson })
    .from(proxyRequestTraces)
    .where(eq(proxyRequestTraces.id, id))
    .limit(1)
    .all();
  return parseTraceRows(rows)[0] ?? null;
}

export function listApiProxyTraces(
  filter: ApiProxyTraceListFilter = {},
): ApiProxyRequestTrace[] {
  const limit = Math.max(
    1,
    Math.min(filter.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  );
  const rows = db
    .select({ traceJson: proxyRequestTraces.traceJson })
    .from(proxyRequestTraces)
    .where(and(...filterConditions(filter)))
    .orderBy(desc(proxyRequestTraces.at), desc(sql`rowid`))
    .limit(limit)
    .all();
  return parseTraceRows(rows);
}

export function countApiProxyTraces(
  filter: ApiProxyTraceListFilter = {},
): number {
  const { before: _before, limit: _limit, ...matchFilter } = filter;
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(proxyRequestTraces)
    .where(and(...filterConditions(matchFilter)))
    .get();
  return row?.count ?? 0;
}

const facetCount = sql<number>`count(*)`;

function columnFacets(
  column: SQLiteColumn,
  options: { skipNull?: boolean; name?: SQL<string | null> } = {},
): ApiProxyTraceFacet[] {
  const rows = db
    .select({
      value: column,
      name: options.name ?? sql<string | null>`null`,
      count: facetCount,
    })
    .from(proxyRequestTraces)
    .where(options.skipNull ? isNotNull(column) : undefined)
    .groupBy(column)
    .orderBy(desc(facetCount))
    .all();
  return rows.map((row) => ({
    value: String(row.value),
    name: row.name,
    count: row.count,
  }));
}

function fileKindFacets(): ApiProxyTraceFacet[] {
  const rows = db.all<{ value: string; count: number }>(sql`
    SELECT kind.value AS value, count(*) AS count
    FROM ${proxyRequestTraces}, json_each(${proxyRequestTraces.fileKinds}) AS kind
    GROUP BY kind.value
    ORDER BY count DESC
  `);
  return rows.map((row) => ({
    value: String(row.value),
    name: null,
    count: Number(row.count),
  }));
}

export function getApiProxyTraceFacets(): ApiProxyTraceFacets {
  return {
    retentionDays: TRACE_RETENTION_DAYS,
    models: columnFacets(proxyRequestTraces.modelId),
    sources: columnFacets(proxyRequestTraces.sourceId, {
      skipNull: true,
      name: sql<string | null>`max(${proxyRequestTraces.sourceName})`,
    }),
    targets: columnFacets(proxyRequestTraces.targetId, {
      skipNull: true,
      name: sql<string | null>`max(${proxyRequestTraces.targetName})`,
    }),
    endpoints: columnFacets(proxyRequestTraces.endpoint),
    protocols: columnFacets(proxyRequestTraces.protocol),
    statuses: columnFacets(proxyRequestTraces.status),
    errorCodes: columnFacets(proxyRequestTraces.errorCode, { skipNull: true }),
    fileKinds: fileKindFacets(),
  };
}

export type ApiProxyTraceActivityRow = {
  modelId: string;
  sourceId: string | null;
  sourceName: string | null;
  requests: number;
  errors: number;
};

export function aggregateApiProxyTraceActivity(
  fromIso: string,
): ApiProxyTraceActivityRow[] {
  const rows = db
    .select({
      modelId: proxyRequestTraces.modelId,
      sourceId: proxyRequestTraces.sourceId,
      sourceName: sql<string | null>`max(${proxyRequestTraces.sourceName})`,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(CASE WHEN ${proxyRequestTraces.ok} = 0 THEN 1 ELSE 0 END)`,
    })
    .from(proxyRequestTraces)
    .where(
      and(
        gte(proxyRequestTraces.at, fromIso),
        ne(proxyRequestTraces.modelId, ""),
      ),
    )
    .groupBy(proxyRequestTraces.modelId, proxyRequestTraces.sourceId)
    .all();
  return rows.map((row) => ({
    modelId: row.modelId,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    requests: Number(row.requests),
    errors: Number(row.errors ?? 0),
  }));
}

export function listApiProxyTracesSince(
  sinceIso: string,
): ApiProxyRequestTrace[] {
  const rows = db
    .select({ traceJson: proxyRequestTraces.traceJson })
    .from(proxyRequestTraces)
    .where(gte(proxyRequestTraces.at, sinceIso))
    .orderBy(asc(proxyRequestTraces.at), asc(sql`rowid`))
    .all();
  return parseTraceRows(rows);
}

export function pruneApiProxyTraceHistory(now = new Date()): {
  prunedTraces: number;
  prunedRequestDirs: number;
} {
  const cutoff = retentionCutoff(now);
  const result = db
    .delete(proxyRequestTraces)
    .where(lt(proxyRequestTraces.at, cutoff))
    .run();
  return {
    prunedTraces: Number(result.changes),
    prunedRequestDirs: pruneApiProxyRequestFiles(cutoff),
  };
}

export function startApiProxyTraceRetentionLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  return startRetentionLoop(() => pruneApiProxyTraceHistory(), options);
}

export function clearApiProxyTraceHistory(): void {
  db.delete(proxyRequestTraces).run();
}
