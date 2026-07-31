import {
  SYSTEM_METRICS_TIERS,
  SystemMetricsSampleSchema,
  type SystemMetricsSample,
} from "@arriero/core";
import { and, asc, eq, gte, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { systemMetricsHistory } from "../db/schema.js";
import {
  averageSamples,
  COARSE_METRICS_WINDOWS,
  type SystemMetricsCoarseWindow,
  type SystemMetricsRecorder,
} from "./metrics-history.js";

const DAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function tierSpanMs(window: SystemMetricsCoarseWindow): number {
  const tier = SYSTEM_METRICS_TIERS[window];
  return tier.capacity * tier.intervalMs;
}

function retentionMs(window: SystemMetricsCoarseWindow): number {
  return window === "day" ? DAY_RETENTION_MS : tierSpanMs(window);
}

export function insertSystemMetricsSample(
  window: SystemMetricsCoarseWindow,
  bucketAt: number,
  sample: SystemMetricsSample,
): void {
  const sampleJson = JSON.stringify(sample);
  db.insert(systemMetricsHistory)
    .values({ window, bucketAt, sampleJson })
    .onConflictDoUpdate({
      target: [systemMetricsHistory.window, systemMetricsHistory.bucketAt],
      set: { sampleJson },
    })
    .run();
}

function parseSampleJson(sampleJson: string): SystemMetricsSample | null {
  let raw: unknown;
  try {
    raw = JSON.parse(sampleJson);
  } catch {
    return null;
  }
  const parsed = SystemMetricsSampleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function selectWindowRows(window: SystemMetricsCoarseWindow, since: number) {
  return db
    .select({
      bucketAt: systemMetricsHistory.bucketAt,
      sampleJson: systemMetricsHistory.sampleJson,
    })
    .from(systemMetricsHistory)
    .where(
      and(
        eq(systemMetricsHistory.window, window),
        gte(systemMetricsHistory.bucketAt, since),
      ),
    )
    .orderBy(asc(systemMetricsHistory.bucketAt))
    .all();
}

export function readSystemMetricsHistory(
  window: SystemMetricsCoarseWindow,
  now = Date.now(),
): SystemMetricsSample[] {
  const rows = selectWindowRows(window, now - tierSpanMs(window));
  const samples: SystemMetricsSample[] = [];
  for (const row of rows) {
    const sample = parseSampleJson(row.sampleJson);
    if (sample) {
      samples.push(sample);
    }
  }
  return samples;
}

export function backfillSystemMetricsMonthTier(now = Date.now()): number {
  const intervalMs = SYSTEM_METRICS_TIERS.month.intervalMs;
  const since = now - tierSpanMs("month");
  const currentBucket = Math.floor(now / intervalMs);
  const existing = new Set(
    selectWindowRows("month", since).map((row) => row.bucketAt),
  );
  const groups = new Map<number, SystemMetricsSample[]>();
  for (const row of selectWindowRows("day", since)) {
    const bucket = Math.floor(row.bucketAt / intervalMs);
    if (bucket >= currentBucket || existing.has(bucket * intervalMs)) {
      continue;
    }
    const sample = parseSampleJson(row.sampleJson);
    if (!sample) {
      continue;
    }
    const group = groups.get(bucket);
    if (group) {
      group.push(sample);
    } else {
      groups.set(bucket, [sample]);
    }
  }
  let inserted = 0;
  for (const [bucket, samples] of groups) {
    const averaged = averageSamples(samples);
    if (!averaged) {
      continue;
    }
    insertSystemMetricsSample("month", bucket * intervalMs, averaged);
    inserted += 1;
  }
  return inserted;
}

export function pruneSystemMetricsHistory(now = Date.now()): number {
  let pruned = 0;
  for (const window of COARSE_METRICS_WINDOWS) {
    const result = db
      .delete(systemMetricsHistory)
      .where(
        and(
          eq(systemMetricsHistory.window, window),
          lt(systemMetricsHistory.bucketAt, now - retentionMs(window)),
        ),
      )
      .run();
    pruned += Number(result.changes);
  }
  return pruned;
}

export function clearSystemMetricsHistory(): void {
  db.delete(systemMetricsHistory).run();
}

function seedWindow(
  recorder: SystemMetricsRecorder,
  window: SystemMetricsCoarseWindow,
  now: number,
): number {
  const samples = readSystemMetricsHistory(window, now);
  recorder.seed(window, samples);
  return samples.length;
}

export function seedSystemMetricsRecorder(
  recorder: SystemMetricsRecorder,
  now = Date.now(),
): Record<SystemMetricsCoarseWindow, number> {
  return {
    hour: seedWindow(recorder, "hour", now),
    day: seedWindow(recorder, "day", now),
    month: seedWindow(recorder, "month", now),
  };
}

export function attachSystemMetricsPersistence(
  recorder: SystemMetricsRecorder,
  options: { onError?: (error: unknown) => void } = {},
): () => void {
  return recorder.subscribeCoarse(({ window, bucketAt, sample }) => {
    try {
      insertSystemMetricsSample(window, bucketAt, sample);
    } catch (error) {
      options.onError?.(error);
    }
  });
}

export function startSystemMetricsRetentionLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  const timer = setInterval(() => {
    try {
      pruneSystemMetricsHistory();
    } catch (error) {
      options.onError?.(error);
    }
  }, PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
