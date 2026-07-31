import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { SYSTEM_METRICS_TIERS } from "@arriero/core";

import { db } from "../db/index.js";
import { systemMetricsHistory } from "../db/schema.js";
import { metricsSampleFixture as sample } from "../test/metrics-sample.js";
import { SystemMetricsRecorder } from "./metrics-history.js";
import {
  attachSystemMetricsPersistence,
  backfillSystemMetricsMonthTier,
  clearSystemMetricsHistory,
  insertSystemMetricsSample,
  pruneSystemMetricsHistory,
  readSystemMetricsHistory,
  seedSystemMetricsRecorder,
} from "./metrics-repository.js";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const HOUR_SPAN_MS =
  SYSTEM_METRICS_TIERS.hour.capacity * SYSTEM_METRICS_TIERS.hour.intervalMs;
const DAY_SPAN_MS =
  SYSTEM_METRICS_TIERS.day.capacity * SYSTEM_METRICS_TIERS.day.intervalMs;

beforeEach(() => {
  clearSystemMetricsHistory();
});

test("reads back persisted buckets within the tier span, oldest first", () => {
  insertSystemMetricsSample(
    "day",
    NOW - 120_000,
    sample({ at: NOW - 120_000, cpuPercent: 10 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW - 60_000,
    sample({ at: NOW - 60_000, cpuPercent: 20 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW - DAY_SPAN_MS - 60_000,
    sample({ at: NOW - DAY_SPAN_MS - 60_000, cpuPercent: 99 }),
  );
  insertSystemMetricsSample(
    "hour",
    NOW - 10_000,
    sample({ at: NOW - 10_000, cpuPercent: 50 }),
  );

  assert.deepEqual(
    readSystemMetricsHistory("day", NOW).map((entry) => entry.cpuPercent),
    [10, 20],
  );
  assert.deepEqual(
    readSystemMetricsHistory("hour", NOW).map((entry) => entry.cpuPercent),
    [50],
  );
});

test("upserts the same bucket instead of duplicating it", () => {
  insertSystemMetricsSample(
    "day",
    NOW - 60_000,
    sample({ at: NOW - 60_000, cpuPercent: 10 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW - 60_000,
    sample({ at: NOW - 30_000, cpuPercent: 30 }),
  );

  const read = readSystemMetricsHistory("day", NOW);
  assert.equal(read.length, 1);
  assert.equal(read[0]?.cpuPercent, 30);
});

test("prunes each window by its own retention", () => {
  insertSystemMetricsSample(
    "hour",
    NOW - HOUR_SPAN_MS - 10_000,
    sample({ at: NOW - HOUR_SPAN_MS - 10_000 }),
  );
  insertSystemMetricsSample("hour", NOW - 10_000, sample({ at: NOW - 10_000 }));
  insertSystemMetricsSample(
    "day",
    NOW - 31 * 24 * 60 * 60 * 1000,
    sample({ at: NOW - 31 * 24 * 60 * 60 * 1000 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW - 2 * DAY_SPAN_MS,
    sample({ at: NOW - 2 * DAY_SPAN_MS }),
  );
  insertSystemMetricsSample("day", NOW - 60_000, sample({ at: NOW - 60_000 }));

  assert.equal(pruneSystemMetricsHistory(NOW), 2);
  const remaining = db.select().from(systemMetricsHistory).all();
  assert.deepEqual(remaining.map((row) => row.window).sort(), [
    "day",
    "day",
    "hour",
  ]);
});

test("skips rows that no longer parse", () => {
  db.insert(systemMetricsHistory)
    .values({ window: "day", bucketAt: NOW - 60_000, sampleJson: "{broken" })
    .run();
  insertSystemMetricsSample(
    "day",
    NOW - 120_000,
    sample({ at: NOW - 120_000 }),
  );

  assert.equal(readSystemMetricsHistory("day", NOW).length, 1);
});

test("seedSystemMetricsRecorder preloads hour and day tiers from the database", () => {
  insertSystemMetricsSample(
    "hour",
    NOW - 20_000,
    sample({ at: NOW - 20_000, cpuPercent: 5 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW - 60_000,
    sample({ at: NOW - 60_000, cpuPercent: 7 }),
  );

  const recorder = new SystemMetricsRecorder({ now: () => NOW });
  const seeded = seedSystemMetricsRecorder(recorder, NOW);

  assert.deepEqual(seeded, { hour: 1, day: 1, month: 0 });
  assert.equal(recorder.history("hour").samples[0]?.cpuPercent, 5);
  assert.equal(recorder.history("day").samples[0]?.cpuPercent, 7);
  assert.equal(recorder.history("live").samples.length, 0);
});

test("backfills missing month buckets from persisted day rows", () => {
  const interval = SYSTEM_METRICS_TIERS.month.intervalMs;
  const bucketA = NOW - 2 * interval;
  const bucketB = NOW - interval;
  insertSystemMetricsSample(
    "day",
    bucketA + 60_000,
    sample({ at: bucketA + 60_000, cpuPercent: 10 }),
  );
  insertSystemMetricsSample(
    "day",
    bucketA + 120_000,
    sample({ at: bucketA + 120_000, cpuPercent: 30 }),
  );
  insertSystemMetricsSample(
    "day",
    bucketB + 60_000,
    sample({ at: bucketB + 60_000, cpuPercent: 50 }),
  );
  insertSystemMetricsSample(
    "day",
    NOW + 60_000,
    sample({ at: NOW + 60_000, cpuPercent: 70 }),
  );
  insertSystemMetricsSample(
    "month",
    bucketB,
    sample({ at: bucketB, cpuPercent: 99 }),
  );

  assert.equal(backfillSystemMetricsMonthTier(NOW + 600_000), 1);

  const rows = db
    .select()
    .from(systemMetricsHistory)
    .all()
    .filter((row) => row.window === "month")
    .sort((a, b) => a.bucketAt - b.bucketAt);
  assert.deepEqual(
    rows.map((row) => row.bucketAt),
    [bucketA, bucketB],
  );
  const read = readSystemMetricsHistory("month", NOW + 600_000);
  assert.deepEqual(
    read.map((entry) => entry.cpuPercent),
    [20, 99],
  );
});

test("attachSystemMetricsPersistence writes each closed coarse bucket", () => {
  let clock = NOW;
  const recorder = new SystemMetricsRecorder({ now: () => (clock += 1_000) });
  const detach = attachSystemMetricsPersistence(recorder);

  for (let index = 0; index < 25; index += 1) {
    recorder.tick();
  }
  detach();
  for (let index = 0; index < 10; index += 1) {
    recorder.tick();
  }

  const rows = db
    .select()
    .from(systemMetricsHistory)
    .all()
    .sort((a, b) => a.bucketAt - b.bucketAt);
  assert.deepEqual(
    rows.map((row) => [row.window, row.bucketAt]),
    [
      ["hour", NOW],
      ["hour", NOW + 10_000],
    ],
  );
  const first = readSystemMetricsHistory("hour", NOW + 25_000)[0];
  assert.equal(first?.at, NOW + 9_000);
  recorder.reset();
});
