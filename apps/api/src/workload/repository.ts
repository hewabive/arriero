import {
  WorkloadRecordSchema,
  WorkloadReplayableOutcomeSchema,
  type WorkloadIndexStatus,
  type WorkloadRecord,
  type WorkloadSessionSummary,
} from "@arriero/core";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";

import { db } from "../db/index.js";
import {
  proxyRequestTraces,
  workloadIndexState,
  workloadRecords,
} from "../db/schema.js";
import { WORKLOAD_REPLAYABLE_ENDPOINTS } from "./record-analysis.js";

export type WorkloadRecordRow = typeof workloadRecords.$inferInsert;

const STATE_ROW_ID = 1;
const LOOKUP_CHUNK = 400;
const EARLIEST_FOUR_DIGIT_YEAR_MS = Date.parse("0000-01-01T00:00:00.000Z");
const FOUR_DIGIT_YEAR_ISO_LENGTH = "0000-01-01T00:00:00.000Z".length;

export type WorkloadIndexState = {
  normalizationVersion: number | null;
  lastPassAt: string | null;
  lastPassIndexed: number;
};

export function readWorkloadIndexState(): WorkloadIndexState {
  const row = db
    .select()
    .from(workloadIndexState)
    .where(eq(workloadIndexState.id, STATE_ROW_ID))
    .get();
  return {
    normalizationVersion: row?.normalizationVersion ?? null,
    lastPassAt: row?.lastPassAt ?? null,
    lastPassIndexed: row?.lastPassIndexed ?? 0,
  };
}

export function writeWorkloadIndexState(state: {
  normalizationVersion: number;
  lastPassAt: string | null;
  lastPassIndexed: number;
}): void {
  db.insert(workloadIndexState)
    .values({ id: STATE_ROW_ID, ...state })
    .onConflictDoUpdate({ target: workloadIndexState.id, set: state })
    .run();
}

export function clearWorkloadRecords(): void {
  db.delete(workloadRecords).run();
}

export function insertWorkloadRecord(row: WorkloadRecordRow): void {
  db.insert(workloadRecords).values(row).onConflictDoNothing().run();
}

export type WorkloadParentCandidate = {
  traceId: string;
  sessionId: string;
  messageCount: number;
  targetId: string | null;
  promptTokens: number | null;
  clientSessionId: string | null;
};

function sourceCondition(sourceId: string | null): SQL {
  return sourceId === null
    ? isNull(workloadRecords.sourceId)
    : eq(workloadRecords.sourceId, sourceId);
}

export function findWorkloadParent(input: {
  sourceId: string | null;
  modelId: string;
  chain: string[];
  before: string;
}): WorkloadParentCandidate | null {
  for (
    let end = input.chain.length;
    end > 0;
    end = Math.max(0, end - LOOKUP_CHUNK)
  ) {
    const chunk = input.chain.slice(Math.max(0, end - LOOKUP_CHUNK), end);
    const row = db
      .select({
        traceId: workloadRecords.traceId,
        sessionId: workloadRecords.sessionId,
        messageCount: workloadRecords.messageCount,
        targetId: workloadRecords.targetId,
        promptTokens: workloadRecords.promptTokens,
        clientSessionId: workloadRecords.clientSessionId,
      })
      .from(workloadRecords)
      .where(
        and(
          sourceCondition(input.sourceId),
          eq(workloadRecords.modelId, input.modelId),
          inArray(workloadRecords.chainKey, chunk),
          lt(workloadRecords.at, input.before),
        ),
      )
      .orderBy(
        desc(workloadRecords.messageCount),
        desc(workloadRecords.at),
        desc(workloadRecords.traceId),
      )
      .limit(1)
      .get();
    if (row && row.messageCount !== null) {
      return { ...row, messageCount: row.messageCount };
    }
  }
  return null;
}

export function latestWorkloadSessionRecordBefore(
  sessionId: string,
  at: string,
): { endAt: string } | null {
  const row = db
    .select({ endAt: workloadRecords.endAt })
    .from(workloadRecords)
    .where(
      and(eq(workloadRecords.sessionId, sessionId), lt(workloadRecords.at, at)),
    )
    .orderBy(desc(workloadRecords.at), desc(workloadRecords.traceId))
    .limit(1)
    .get();
  return row ?? null;
}

export function pruneWorkloadRecords(cutoff: string): number {
  const pruned = db
    .delete(workloadRecords)
    .where(lt(workloadRecords.at, cutoff))
    .run();
  const orphaned = db
    .delete(workloadRecords)
    .where(
      notInArray(
        workloadRecords.traceId,
        db.select({ id: proxyRequestTraces.id }).from(proxyRequestTraces),
      ),
    )
    .run();
  return Number(pruned.changes) + Number(orphaned.changes);
}

function toWorkloadRecord(
  row: typeof workloadRecords.$inferSelect,
): WorkloadRecord | null {
  const parsed = WorkloadRecordSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

function presentRecords(
  rows: Array<typeof workloadRecords.$inferSelect>,
): WorkloadRecord[] {
  const records: WorkloadRecord[] = [];
  for (const row of rows) {
    const record = toWorkloadRecord(row);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export type WorkloadScope = {
  from?: string | undefined;
  to?: string | undefined;
  sourceId?: string | undefined;
  modelId?: string | undefined;
  targetId?: string | undefined;
};

function longestWorkloadDurationMs(): number | null {
  const row = db
    .select({ longest: max(workloadRecords.durationMs) })
    .from(workloadRecords)
    .get();
  return row?.longest ?? null;
}

function isFourDigitYearIsoTimestamp(value: string): boolean {
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    value.length === FOUR_DIGIT_YEAR_ISO_LENGTH &&
    new Date(ms).toISOString() === value
  );
}

function earliestStartEndingFrom(from: string): string | null {
  if (!isFourDigitYearIsoTimestamp(from)) {
    return null;
  }
  const longest = longestWorkloadDurationMs();
  const earliestMs = longest === null ? null : Date.parse(from) - longest;
  return earliestMs !== null && earliestMs >= EARLIEST_FOUR_DIGIT_YEAR_MS
    ? new Date(earliestMs).toISOString()
    : null;
}

function scopeConditions(scope: WorkloadScope): SQL[] {
  const conditions: SQL[] = [
    inArray(
      workloadRecords.endpoint,
      Object.values(WORKLOAD_REPLAYABLE_ENDPOINTS),
    ),
  ];
  if (scope.from !== undefined) {
    conditions.push(gte(workloadRecords.endAt, scope.from));
    const earliestStart = earliestStartEndingFrom(scope.from);
    if (earliestStart !== null) {
      conditions.push(gte(workloadRecords.at, earliestStart));
    }
  }
  if (scope.to !== undefined) {
    conditions.push(lte(workloadRecords.at, scope.to));
  }
  if (scope.sourceId !== undefined) {
    conditions.push(eq(workloadRecords.sourceId, scope.sourceId));
  }
  if (scope.modelId !== undefined) {
    conditions.push(eq(workloadRecords.modelId, scope.modelId));
  }
  if (scope.targetId !== undefined) {
    conditions.push(eq(workloadRecords.targetId, scope.targetId));
  }
  return conditions;
}

export function listWorkloadRecords(scope: WorkloadScope): WorkloadRecord[] {
  const rows = db
    .select()
    .from(workloadRecords)
    .where(and(...scopeConditions(scope)))
    .orderBy(asc(workloadRecords.at), asc(workloadRecords.traceId))
    .all();
  return presentRecords(rows);
}

export function getWorkloadRecord(traceId: string): WorkloadRecord | null {
  const row = db
    .select()
    .from(workloadRecords)
    .where(eq(workloadRecords.traceId, traceId))
    .get();
  return row ? toWorkloadRecord(row) : null;
}

export function listWorkloadSessionRecords(
  sessionId: string,
): WorkloadRecord[] {
  const rows = db
    .select()
    .from(workloadRecords)
    .where(eq(workloadRecords.sessionId, sessionId))
    .orderBy(asc(workloadRecords.at), asc(workloadRecords.traceId))
    .all();
  return presentRecords(rows);
}

export function listWorkloadSessions(
  scope: WorkloadScope & {
    before?: { at: string; sessionId: string } | undefined;
    limit: number;
  },
): WorkloadSessionSummary[] {
  const startedAt = min(workloadRecords.at);
  const having: SQL[] = [];
  if (scope.before) {
    having.push(
      sql`(${startedAt} < ${scope.before.at} OR (${startedAt} = ${scope.before.at} AND ${workloadRecords.sessionId} < ${scope.before.sessionId}))`,
    );
  }
  const rows = db
    .select({
      sessionId: workloadRecords.sessionId,
      sourceId: max(workloadRecords.sourceId),
      sourceName: max(workloadRecords.sourceName),
      modelId: max(workloadRecords.modelId),
      startedAt,
      endedAt: max(workloadRecords.endAt),
      records: count(),
      replayable: sql<number>`SUM(CASE WHEN ${workloadRecords.issue} IS NULL AND ${inArray(workloadRecords.outcome, WorkloadReplayableOutcomeSchema.options)} THEN 1 ELSE 0 END)`,
      errors: sql<number>`SUM(CASE WHEN ${workloadRecords.outcome} = 'error' THEN 1 ELSE 0 END)`,
      notServed: sql<number>`SUM(CASE WHEN ${workloadRecords.outcome} = 'not-served' THEN 1 ELSE 0 END)`,
      clientAborts: sql<number>`SUM(CASE WHEN ${workloadRecords.outcome} = 'client-abort' THEN 1 ELSE 0 END)`,
      maxPromptTokens: max(workloadRecords.promptTokens),
      targetNames: sql<
        string | null
      >`group_concat(DISTINCT ${workloadRecords.targetName})`,
    })
    .from(workloadRecords)
    .where(and(...scopeConditions(scope)))
    .groupBy(workloadRecords.sessionId)
    .having(having.length > 0 ? and(...having) : undefined)
    .orderBy(desc(startedAt), desc(workloadRecords.sessionId))
    .limit(scope.limit)
    .all();
  const sessions: WorkloadSessionSummary[] = [];
  for (const row of rows) {
    if (
      row.modelId === null ||
      row.startedAt === null ||
      row.endedAt === null
    ) {
      continue;
    }
    sessions.push({
      sessionId: row.sessionId,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      modelId: row.modelId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      records: Number(row.records),
      replayable: Number(row.replayable ?? 0),
      errors: Number(row.errors ?? 0),
      notServed: Number(row.notServed ?? 0),
      clientAborts: Number(row.clientAborts ?? 0),
      maxPromptTokens: row.maxPromptTokens,
      targetNames: row.targetNames ? row.targetNames.split(",").sort() : [],
    });
  }
  return sessions;
}

export function workloadIndexStatus(): WorkloadIndexStatus {
  const totals = db
    .select({
      records: count(),
      oldestAt: min(workloadRecords.at),
      newestAt: max(workloadRecords.at),
    })
    .from(workloadRecords)
    .get();
  const state = readWorkloadIndexState();
  return {
    normalizationVersion: state.normalizationVersion,
    records: Number(totals?.records ?? 0),
    oldestAt: totals?.oldestAt ?? null,
    newestAt: totals?.newestAt ?? null,
    lastPassAt: state.lastPassAt,
    lastPassIndexed: state.lastPassIndexed,
  };
}

export function newestWorkloadRecordAt(): string | null {
  const row = db
    .select({ newestAt: max(workloadRecords.at) })
    .from(workloadRecords)
    .get();
  return row?.newestAt ?? null;
}
