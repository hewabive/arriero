import type { WebappStopReason } from "@arriero/core";
import { desc, eq, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { webappRuns } from "../db/schema.js";
import {
  buildRunPredicates,
  collectProtectedRunLogPaths,
} from "../process/run-predicates.js";
import { newId } from "../utils/id.js";

export type WebappRun = typeof webappRuns.$inferSelect;

const {
  openRun: openRunPredicate,
  prunableClosedRun: prunableClosedRunPredicate,
} = buildRunPredicates(webappRuns, {
  id: webappRuns.id,
  owner: webappRuns.webappId,
  status: webappRuns.status,
  startedAt: webappRuns.startedAt,
  stoppedAt: webappRuns.stoppedAt,
});

export function createWebappRun(input: {
  webappId: string;
  pid: number | null;
  status: string;
  startedAt: string;
  logPath: string;
  rawLogPath: string | null;
  launchSnapshot?: string | null;
}) {
  const id = newId();
  db.insert(webappRuns)
    .values({
      id,
      webappId: input.webappId,
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
    sql`DELETE FROM ${webappRuns} WHERE ${webappRuns.webappId} = ${input.webappId} AND ${prunableClosedRunPredicate}`,
  );
  return id;
}

export function updateWebappRun(
  id: string,
  input: {
    pid?: number | null;
    status?: string;
    stoppedAt?: string | null;
    exitCode?: number | null;
    adopted?: boolean;
    stopReason?: WebappStopReason | null;
  },
) {
  db.update(webappRuns)
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
    .where(eq(webappRuns.id, id))
    .run();
}

export function renameWebappRuns(from: string, to: string): void {
  if (from === to) {
    return;
  }
  db.update(webappRuns)
    .set({ webappId: to })
    .where(eq(webappRuns.webappId, from))
    .run();
}

export function openWebappRun(webappId: string): WebappRun | null {
  return (
    db
      .select()
      .from(webappRuns)
      .where(sql`${webappRuns.webappId} = ${webappId} AND ${openRunPredicate}`)
      .orderBy(desc(webappRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export function latestWebappRun(webappId: string): WebappRun | null {
  return (
    db
      .select()
      .from(webappRuns)
      .where(eq(webappRuns.webappId, webappId))
      .orderBy(desc(webappRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export function listOpenWebappRuns(): WebappRun[] {
  return db
    .select()
    .from(webappRuns)
    .where(openRunPredicate)
    .orderBy(desc(webappRuns.startedAt))
    .all();
}

export function listWebappRunLogPaths(webappId: string): string[] {
  const rows = db
    .select({
      logPath: webappRuns.logPath,
      rawLogPath: webappRuns.rawLogPath,
    })
    .from(webappRuns)
    .where(eq(webappRuns.webappId, webappId))
    .all();
  return rows.flatMap((row) =>
    [row.logPath, row.rawLogPath].filter((path): path is string =>
      Boolean(path),
    ),
  );
}

export function listProtectedWebappRunLogPaths(): string[] {
  const rows = db
    .select({
      owner: webappRuns.webappId,
      status: webappRuns.status,
      startedAt: webappRuns.startedAt,
      stoppedAt: webappRuns.stoppedAt,
      logPath: webappRuns.logPath,
      rawLogPath: webappRuns.rawLogPath,
    })
    .from(webappRuns)
    .all();
  return collectProtectedRunLogPaths(rows);
}

export function deleteWebappRuns(webappId: string): { deleted: number } {
  const result = db.run(
    sql`DELETE FROM ${webappRuns} WHERE ${webappRuns.webappId} = ${webappId}`,
  );
  return { deleted: Number(result.changes) };
}

export function pruneWebappRunHistory(): { deleted: number } {
  const result = db.run(
    sql`DELETE FROM ${webappRuns} WHERE ${prunableClosedRunPredicate}`,
  );
  return { deleted: Number(result.changes) };
}
