import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

const RETAINED_CLOSED_RUNS_PER_OWNER = 20;

const OPEN_RUN_STATUSES = ["starting", "running", "stopping", "stale"];

const openRunStatusList = sql.join(
  OPEN_RUN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

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
