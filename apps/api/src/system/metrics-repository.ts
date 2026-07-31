import {
  SYSTEM_METRICS_TIERS,
  SystemMetricsSampleSchema,
  type SystemMetricsCoarseWindow,
  type SystemMetricsSample,
} from "@arriero/core";
import { and, asc, eq, gte, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { parsePersistedJson } from "../db/persisted-json.js";
import { startRetentionLoop } from "../db/retention.js";
import { systemMetricsHistory } from "../db/schema.js";
import {
  averageSamples,
  COARSE_METRICS_WINDOWS,
  type SystemMetricsRecorder,
} from "./metrics-history.js";

function tierSpanMs(window: SystemMetricsCoarseWindow): number {
  const tier = SYSTEM_METRICS_TIERS[window];
  return tier.capacity * tier.intervalMs;
}

function retentionMs(window: SystemMetricsCoarseWindow): number {
  return window === "day"
    ? Math.max(tierSpanMs("day"), tierSpanMs("month"))
    : tierSpanMs(window);
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

function selectBucketStarts(
  window: SystemMetricsCoarseWindow,
  since: number,
): number[] {
  return db
    .select({ bucketAt: systemMetricsHistory.bucketAt })
    .from(systemMetricsHistory)
    .where(
      and(
        eq(systemMetricsHistory.window, window),
        gte(systemMetricsHistory.bucketAt, since),
      ),
    )
    .orderBy(asc(systemMetricsHistory.bucketAt))
    .all()
    .map((row) => row.bucketAt);
}

export function readSystemMetricsHistory(
  window: SystemMetricsCoarseWindow,
  now = Date.now(),
): SystemMetricsSample[] {
  const rows = selectWindowRows(window, now - tierSpanMs(window));
  const samples: SystemMetricsSample[] = [];
  for (const row of rows) {
    const sample = parsePersistedJson(
      SystemMetricsSampleSchema,
      row.sampleJson,
    );
    if (sample) {
      samples.push(sample);
    }
  }
  return samples;
}

export function backfillSystemMetricsMonthTier(now = Date.now()): number {
  const intervalMs = SYSTEM_METRICS_TIERS.month.intervalMs;
  const since = now - tierSpanMs("month");
  const currentBucketAt = Math.floor(now / intervalMs) * intervalMs;
  const monthBucketOf = (bucketAt: number) =>
    Math.floor(bucketAt / intervalMs) * intervalMs;

  const dayBucketStarts = selectBucketStarts("day", since);
  if (dayBucketStarts.length === 0) {
    return 0;
  }
  const existing = new Set(selectBucketStarts("month", since));
  const missing = new Set<number>();
  for (const dayBucketAt of dayBucketStarts) {
    const monthBucketAt = monthBucketOf(dayBucketAt);
    if (monthBucketAt < currentBucketAt && !existing.has(monthBucketAt)) {
      missing.add(monthBucketAt);
    }
  }
  if (missing.size === 0) {
    return 0;
  }

  const groups = new Map<number, SystemMetricsSample[]>();
  for (const row of selectWindowRows("day", Math.min(...missing))) {
    const monthBucketAt = monthBucketOf(row.bucketAt);
    if (!missing.has(monthBucketAt)) {
      continue;
    }
    const sample = parsePersistedJson(
      SystemMetricsSampleSchema,
      row.sampleJson,
    );
    if (!sample) {
      continue;
    }
    const group = groups.get(monthBucketAt);
    if (group) {
      group.push(sample);
    } else {
      groups.set(monthBucketAt, [sample]);
    }
  }
  let inserted = 0;
  for (const [monthBucketAt, samples] of groups) {
    const averaged = averageSamples(samples);
    if (!averaged) {
      continue;
    }
    insertSystemMetricsSample("month", monthBucketAt, averaged);
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

export function initSystemMetricsPersistence(
  recorder: SystemMetricsRecorder,
  options: { onError?: (error: unknown) => void } = {},
): {
  pruned: number;
  backfilledMonth: number;
  seeded: Record<SystemMetricsCoarseWindow, number>;
} {
  const pruned = pruneSystemMetricsHistory();
  const backfilledMonth = backfillSystemMetricsMonthTier();
  const seeded = seedSystemMetricsRecorder(recorder);
  attachSystemMetricsPersistence(recorder, options);
  return { pruned, backfilledMonth, seeded };
}

export function startSystemMetricsRetentionLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  return startRetentionLoop(() => pruneSystemMetricsHistory(), options);
}
