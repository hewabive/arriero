import { and, desc, eq } from "drizzle-orm";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  BackgroundJobStatusSchema,
  BenchmarkRunResultSchema,
  BenchmarkScenarioSchema,
  BenchmarkRunSummarySchema,
  BenchmarkStreamEventSchema,
  BenchmarkTargetSnapshotSchema,
  type BackgroundJobStatus,
  type BenchmarkRun,
  type BenchmarkRunResult,
  type BenchmarkRunSummary,
  type BenchmarkScenario,
  type BenchmarkStreamEvent,
  type BenchmarkTargetSnapshot,
} from "@arriero/core";
import { z } from "zod";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { benchmarkRuns } from "../db/schema.js";
import { logger } from "../logger.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

export const benchmarkArtifactsRoot = resolve(config.dataDir, "benchmarks");

const WarningsSchema = z.array(z.string());

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonColumn(
  runId: string,
  column: string,
  value: string | null,
): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    logger.warn(
      { runId, column, error: (error as Error).message },
      "corrupt benchmark run column",
    );
    return null;
  }
}

function parseColumn<T>(
  runId: string,
  column: string,
  schema: z.ZodType<T>,
  value: string | null,
): T | null {
  const parsed = parseJsonColumn(runId, column, value);
  if (parsed === null) return null;
  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  logger.warn(
    { runId, column, issues: result.error.issues },
    "invalid benchmark run column",
  );
  return null;
}

function fromRow(row: typeof benchmarkRuns.$inferSelect): BenchmarkRun | null {
  const scenario = parseColumn(
    row.id,
    "scenario",
    BenchmarkScenarioSchema,
    row.scenarioJson,
  );
  if (!scenario) {
    return null;
  }
  const status = BackgroundJobStatusSchema.safeParse(row.status);
  if (!status.success) {
    logger.warn(
      { runId: row.id, status: row.status },
      "invalid benchmark run status",
    );
    return null;
  }
  return {
    id: row.id,
    status: status.data,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    label: row.label,
    scenario,
    snapshot: parseColumn(
      row.id,
      "snapshot",
      BenchmarkTargetSnapshotSchema,
      row.snapshotJson,
    ),
    warnings:
      parseColumn(row.id, "warnings", WarningsSchema, row.warningsJson) ?? [],
    summary: parseColumn(
      row.id,
      "summary",
      BenchmarkRunSummarySchema,
      row.summaryJson,
    ),
    error: row.error,
    progress: null,
  };
}

export function createBenchmarkRun(input: {
  id: string;
  scenario: BenchmarkScenario;
}): BenchmarkRun {
  const createdAt = nowIso();
  db.insert(benchmarkRuns)
    .values({
      id: input.id,
      status: "running",
      createdAt,
      finishedAt: null,
      instanceId: input.scenario.target.instanceName,
      label: input.scenario.label ?? null,
      scenarioJson: JSON.stringify(input.scenario),
      snapshotJson: null,
      warningsJson: JSON.stringify([]),
      summaryJson: null,
      error: null,
    })
    .run();
  return {
    id: input.id,
    status: "running",
    createdAt,
    finishedAt: null,
    label: input.scenario.label ?? null,
    scenario: input.scenario,
    snapshot: null,
    warnings: [],
    summary: null,
    error: null,
    progress: null,
  };
}

export type BenchmarkRunPatch = {
  status?: BackgroundJobStatus;
  finishedAt?: string | null;
  snapshot?: BenchmarkTargetSnapshot;
  warnings?: string[];
  summary?: BenchmarkRunSummary;
  error?: string | null;
};

export function patchBenchmarkRun(id: string, patch: BenchmarkRunPatch): void {
  const values: Partial<typeof benchmarkRuns.$inferInsert> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.finishedAt !== undefined) values.finishedAt = patch.finishedAt;
  if (patch.snapshot !== undefined) {
    values.snapshotJson = JSON.stringify(patch.snapshot);
  }
  if (patch.warnings !== undefined) {
    values.warningsJson = JSON.stringify(patch.warnings);
  }
  if (patch.summary !== undefined) {
    values.summaryJson = JSON.stringify(patch.summary);
  }
  if (patch.error !== undefined) values.error = patch.error;
  if (Object.keys(values).length === 0) return;
  db.update(benchmarkRuns).set(values).where(eq(benchmarkRuns.id, id)).run();
}

export function getBenchmarkRun(id: string): BenchmarkRun | null {
  const row = db
    .select()
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.id, id))
    .get();
  return row ? fromRow(row) : null;
}

export type BenchmarkRunListFilter = {
  status?: BackgroundJobStatus;
  label?: string;
};

export function listBenchmarkRuns(
  limit: number,
  filter: BenchmarkRunListFilter = {},
): BenchmarkRun[] {
  const rows = db
    .select()
    .from(benchmarkRuns)
    .where(
      and(
        ...(filter.status !== undefined
          ? [eq(benchmarkRuns.status, filter.status)]
          : []),
        ...(filter.label !== undefined
          ? [eq(benchmarkRuns.label, filter.label)]
          : []),
      ),
    )
    .orderBy(desc(benchmarkRuns.createdAt))
    .limit(limit)
    .all();
  return rows.map(fromRow).filter((run): run is BenchmarkRun => run !== null);
}

export function deleteBenchmarkRun(id: string): boolean {
  const result = db.delete(benchmarkRuns).where(eq(benchmarkRuns.id, id)).run();
  if (result.changes === 0) {
    return false;
  }
  const artifactsDir = benchmarkRunArtifactsDir(id);
  if (artifactsDir) {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
  return true;
}

export function failInterruptedBenchmarkRuns(): number {
  const result = db
    .update(benchmarkRuns)
    .set({
      status: "failed",
      finishedAt: nowIso(),
      error: "interrupted by manager restart",
    })
    .where(eq(benchmarkRuns.status, "running"))
    .run();
  return result.changes;
}

function benchmarkRunArtifactsDir(id: string): string | null {
  const dir = resolve(benchmarkArtifactsRoot, id);
  return dir.startsWith(`${benchmarkArtifactsRoot}${sep}`) ? dir : null;
}

export function writeBenchmarkRunArtifacts(
  id: string,
  events: readonly BenchmarkStreamEvent[],
  result: BenchmarkRunResult,
): void {
  const dir = benchmarkRunArtifactsDir(id);
  if (!dir) {
    throw new Error(`invalid benchmark run id: ${id}`);
  }
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  atomicWriteFile(resolve(dir, "events.jsonl"), lines ? `${lines}\n` : "");
  atomicWriteFile(
    resolve(dir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

export function readBenchmarkRunEvents(
  id: string,
): BenchmarkStreamEvent[] | null {
  const dir = benchmarkRunArtifactsDir(id);
  if (!dir) return null;
  const path = resolve(dir, "events.jsonl");
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const parsed = z
      .array(BenchmarkStreamEventSchema)
      .safeParse(lines.map((line) => JSON.parse(line) as unknown));
    if (parsed.success) {
      return parsed.data;
    }
    logger.warn(
      { runId: id, issues: parsed.error.issues },
      "invalid benchmark run events artifact",
    );
  } catch (error) {
    logger.warn(
      { runId: id, error: (error as Error).message },
      "unreadable benchmark run events artifact",
    );
  }
  return null;
}

export function readBenchmarkRunResult(id: string): BenchmarkRunResult | null {
  const dir = benchmarkRunArtifactsDir(id);
  if (!dir) return null;
  const path = resolve(dir, "result.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = BenchmarkRunResultSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (parsed.success) {
      return parsed.data;
    }
    logger.warn(
      { runId: id, issues: parsed.error.issues },
      "invalid benchmark run result artifact",
    );
  } catch (error) {
    logger.warn(
      { runId: id, error: (error as Error).message },
      "unreadable benchmark run result artifact",
    );
  }
  return null;
}
