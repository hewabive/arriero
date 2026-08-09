import type { ProcessStopReason } from "@arriero/core";
import { desc, eq, sql } from "drizzle-orm";
import { newId } from "../utils/id.js";

import { db } from "../db/index.js";
import { processRuns } from "../db/schema.js";

export type ProcessRun = typeof processRuns.$inferSelect;
export type { ProcessStopReason } from "@arriero/core";

const RETAINED_CLOSED_RUNS_PER_INSTANCE = 20;

const OPEN_RUN_STATUSES = ["starting", "running", "stopping", "stale"];

const openRunStatusList = sql.join(
  OPEN_RUN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

const openRunPredicate = sql`${processRuns.stoppedAt} IS NULL AND ${processRuns.status} IN (${openRunStatusList})`;

const prunableClosedRunPredicate = sql`NOT (${openRunPredicate}) AND ${processRuns.id} NOT IN (
  SELECT id FROM ${processRuns} AS retained
  WHERE retained.instance_id = ${processRuns.instanceId}
    AND NOT (retained.stopped_at IS NULL AND retained.status IN (${openRunStatusList}))
  ORDER BY retained.started_at DESC
  LIMIT ${RETAINED_CLOSED_RUNS_PER_INSTANCE}
)`;

export function createProcessRun(input: {
  instanceId: string;
  pid: number | null;
  status: string;
  startedAt: string;
  logPath: string;
  rawLogPath: string | null;
  launchSnapshot?: string | null;
}) {
  const id = newId();
  db.insert(processRuns)
    .values({
      id,
      instanceId: input.instanceId,
      pid: input.pid === null ? null : String(input.pid),
      status: input.status,
      startedAt: input.startedAt,
      stoppedAt: null,
      exitCode: null,
      logPath: input.logPath,
      rawLogPath: input.rawLogPath,
      launchSnapshot: input.launchSnapshot ?? null,
      adopted: null,
    })
    .run();
  db.run(
    sql`DELETE FROM ${processRuns} WHERE ${processRuns.instanceId} = ${input.instanceId} AND ${prunableClosedRunPredicate}`,
  );
  return id;
}

export function renameProcessRunsInstance(from: string, to: string): void {
  if (from === to) {
    return;
  }
  db.update(processRuns)
    .set({ instanceId: to })
    .where(eq(processRuns.instanceId, from))
    .run();
}

export function openProcessRunForInstance(
  instanceId: string,
): ProcessRun | null {
  return (
    db
      .select()
      .from(processRuns)
      .where(
        sql`${processRuns.instanceId} = ${instanceId} AND ${openRunPredicate}`,
      )
      .orderBy(desc(processRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export function deleteProcessRunsForInstance(instanceId: string): {
  deleted: number;
} {
  const result = db.run(
    sql`DELETE FROM ${processRuns} WHERE ${processRuns.instanceId} = ${instanceId}`,
  );
  return { deleted: Number(result.changes) };
}

export function pruneProcessRunHistory(): { deleted: number } {
  const result = db.run(
    sql`DELETE FROM ${processRuns} WHERE ${prunableClosedRunPredicate}`,
  );
  return { deleted: Number(result.changes) };
}

export function updateProcessRun(
  id: string,
  input: {
    pid?: number | null;
    status?: string;
    stoppedAt?: string | null;
    exitCode?: number | null;
    adopted?: boolean;
    stopReason?: ProcessStopReason | null;
  },
) {
  db.update(processRuns)
    .set({
      ...(input.pid !== undefined
        ? { pid: input.pid === null ? null : String(input.pid) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
      ...(input.exitCode !== undefined
        ? { exitCode: input.exitCode === null ? null : String(input.exitCode) }
        : {}),
      ...(input.adopted !== undefined
        ? { adopted: input.adopted ? "true" : null }
        : {}),
      ...(input.stopReason !== undefined
        ? { stopReason: input.stopReason }
        : {}),
    })
    .where(eq(processRuns.id, id))
    .run();
}

export function latestProcessRun(instanceId: string): ProcessRun | null {
  return (
    db
      .select()
      .from(processRuns)
      .where(eq(processRuns.instanceId, instanceId))
      .orderBy(desc(processRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export function listOpenProcessRuns(): ProcessRun[] {
  return db
    .select()
    .from(processRuns)
    .where(openRunPredicate)
    .orderBy(desc(processRuns.startedAt))
    .all();
}
