import {
  SYSTEM_METRICS_TIERS,
  SystemMetricsSampleSchema,
  type SystemMetricsSample,
} from "@arriero/core";
import { and, asc, eq, gte, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { systemMetricsHistory } from "../db/schema.js";
import {
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

export function readSystemMetricsHistory(
  window: SystemMetricsCoarseWindow,
  now = Date.now(),
): SystemMetricsSample[] {
  const rows = db
    .select({ sampleJson: systemMetricsHistory.sampleJson })
    .from(systemMetricsHistory)
    .where(
      and(
        eq(systemMetricsHistory.window, window),
        gte(systemMetricsHistory.bucketAt, now - tierSpanMs(window)),
      ),
    )
    .orderBy(asc(systemMetricsHistory.bucketAt))
    .all();
  const samples: SystemMetricsSample[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.sampleJson);
    } catch {
      continue;
    }
    const parsed = SystemMetricsSampleSchema.safeParse(raw);
    if (parsed.success) {
      samples.push(parsed.data);
    }
  }
  return samples;
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
