import {
  ApiProxyRequestTraceSchema,
  type ApiProxyRequestTrace,
  type ApiProxyTraceFacet,
  type ApiProxyTraceFacets,
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
  sql,
  type SQL,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { db } from "../db/index.js";
import { proxyRequestTraces } from "../db/schema.js";
import { pruneApiProxyRequestFiles } from "./request-files.js";

const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

let lastPruneMs: number | null = null;

function retentionCutoff(now: Date): string {
  return new Date(
    now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
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
      targetId: trace.targetId,
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
      traceJson: JSON.stringify(trace),
    })
    .run();
  const now = Date.now();
  if (lastPruneMs === null) {
    lastPruneMs = now;
    return;
  }
  if (now - lastPruneMs >= PRUNE_INTERVAL_MS) {
    lastPruneMs = now;
    pruneApiProxyTraceHistory();
  }
}

function parseTraceRows(
  rows: Array<{ traceJson: string }>,
): ApiProxyRequestTrace[] {
  const traces: ApiProxyRequestTrace[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.traceJson);
    } catch {
      continue;
    }
    const parsed = ApiProxyRequestTraceSchema.safeParse(raw);
    if (parsed.success) {
      traces.push(parsed.data);
    }
  }
  return traces;
}

export type ApiProxyTraceCacheFilter = "hit" | "store" | "coalesced" | "none";

export type ApiProxyTraceListFilter = {
  limit?: number;
  before?: string;
  from?: string;
  to?: string;
  protocol?: string;
  endpoint?: string;
  modelId?: string;
  sourceId?: string;
  targetId?: string;
  ok?: boolean;
  status?: number;
  errorCode?: string;
  cache?: ApiProxyTraceCacheFilter;
  resumed?: boolean;
  stream?: boolean;
  translated?: boolean;
  minDurationMs?: number;
};

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
  if (filter.minDurationMs !== undefined) {
    conditions.push(gte(proxyRequestTraces.durationMs, filter.minDurationMs));
  }
  return conditions;
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
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(proxyRequestTraces)
    .where(and(...filterConditions(filter)))
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

export function getApiProxyTraceFacets(): ApiProxyTraceFacets {
  return {
    models: columnFacets(proxyRequestTraces.modelId),
    sources: columnFacets(proxyRequestTraces.sourceId, {
      skipNull: true,
      name: sql<
        string | null
      >`max(json_extract(${proxyRequestTraces.traceJson}, '$.sourceName'))`,
    }),
    targets: columnFacets(proxyRequestTraces.targetId, {
      skipNull: true,
      name: sql<
        string | null
      >`max(json_extract(${proxyRequestTraces.traceJson}, '$.targetName'))`,
    }),
    endpoints: columnFacets(proxyRequestTraces.endpoint),
    protocols: columnFacets(proxyRequestTraces.protocol),
    statuses: columnFacets(proxyRequestTraces.status),
    errorCodes: columnFacets(proxyRequestTraces.errorCode, { skipNull: true }),
  };
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

export function clearApiProxyTraceHistory(): void {
  db.delete(proxyRequestTraces).run();
}
