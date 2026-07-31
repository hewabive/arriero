import {
  ApiProxyRequestTraceSchema,
  type ApiProxyRequestTrace,
} from "@arriero/core";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

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

export type ApiProxyTraceListFilter = {
  limit?: number;
  before?: string;
  modelId?: string;
  sourceId?: string;
  targetId?: string;
  ok?: boolean;
};

export function listApiProxyTraces(
  filter: ApiProxyTraceListFilter = {},
): ApiProxyRequestTrace[] {
  const conditions: SQL[] = [];
  if (filter.before !== undefined) {
    conditions.push(lt(proxyRequestTraces.at, filter.before));
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
  const limit = Math.max(
    1,
    Math.min(filter.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  );
  const rows = db
    .select({ traceJson: proxyRequestTraces.traceJson })
    .from(proxyRequestTraces)
    .where(and(...conditions))
    .orderBy(desc(proxyRequestTraces.at), desc(sql`rowid`))
    .limit(limit)
    .all();
  return parseTraceRows(rows);
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
