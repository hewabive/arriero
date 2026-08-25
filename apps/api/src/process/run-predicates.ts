import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

const RETAINED_CLOSED_RUNS_PER_OWNER = 20;

const OPEN_RUN_STATUSES = ["starting", "running", "stopping", "stale"];

const openRunStatusList = sql.join(
  OPEN_RUN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

export function collectProtectedRunLogPaths(
  rows: Array<{
    owner: string;
    status: string;
    startedAt: string;
    stoppedAt: string | null;
    logPath: string | null;
    rawLogPath: string | null;
  }>,
): string[] {
  const paths = new Set<string>();
  const latestByOwner = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const isOpen =
      row.stoppedAt === null && OPEN_RUN_STATUSES.includes(row.status);
    if (isOpen) {
      addRunLogPaths(paths, row);
    }
    const latest = latestByOwner.get(row.owner);
    if (!latest || row.startedAt > latest.startedAt) {
      latestByOwner.set(row.owner, row);
    }
  }
  for (const row of latestByOwner.values()) {
    addRunLogPaths(paths, row);
  }
  return [...paths];
}

function addRunLogPaths(
  paths: Set<string>,
  row: { logPath: string | null; rawLogPath: string | null },
): void {
  if (row.logPath) {
    paths.add(row.logPath);
  }
  if (row.rawLogPath) {
    paths.add(row.rawLogPath);
  }
}

export function buildRunPredicates(
  table: SQLiteTable,
  columns: {
    id: SQLiteColumn;
    owner: SQLiteColumn;
    status: SQLiteColumn;
    startedAt: SQLiteColumn;
    stoppedAt: SQLiteColumn;
  },
): { openRun: SQL; prunableClosedRun: SQL } {
  const retained = (column: SQLiteColumn) => sql.raw(`retained.${column.name}`);
  const openRun = sql`${columns.stoppedAt} IS NULL AND ${columns.status} IN (${openRunStatusList})`;
  const prunableClosedRun = sql`NOT (${openRun}) AND ${columns.id} NOT IN (
  SELECT id FROM ${table} AS retained
  WHERE ${retained(columns.owner)} = ${columns.owner}
    AND NOT (${retained(columns.stoppedAt)} IS NULL AND ${retained(columns.status)} IN (${openRunStatusList}))
  ORDER BY ${retained(columns.startedAt)} DESC
  LIMIT ${RETAINED_CLOSED_RUNS_PER_OWNER}
)`;
  return { openRun, prunableClosedRun };
}
