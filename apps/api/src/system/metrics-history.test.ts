import { SYSTEM_METRICS_TIERS, type SystemMetricsSample } from "@arriero/core";
import { strict as assert } from "node:assert";
import test from "node:test";

import { averageSamples, SystemMetricsRecorder } from "./metrics-history.js";

function sample(input: Partial<SystemMetricsSample>): SystemMetricsSample {
  return {
    at: 0,
    cpuPercent: 0,
    memoryUsedBytes: 0,
    memoryTotalBytes: 1_000,
    gpus: [],
    disks: [],
    network: [],
    ...input,
  };
}

test("averageSamples averages scalars and keeps the newest timestamp", () => {
  const averaged = averageSamples([
    sample({ at: 1_000, cpuPercent: 20, memoryUsedBytes: 100 }),
    sample({ at: 2_000, cpuPercent: 40, memoryUsedBytes: 300 }),
  ]);

  assert.ok(averaged);
  assert.equal(averaged.at, 2_000);
  assert.equal(averaged.cpuPercent, 30);
  assert.equal(averaged.memoryUsedBytes, 200);
});

test("averageSamples merges devices by identity across the window", () => {
  const averaged = averageSamples([
    sample({
      disks: [
        {
          name: "nvme0n1",
          utilPercent: 10,
          readBytesPerSec: 100,
          writeBytesPerSec: null,
        },
      ],
      gpus: [
        {
          id: "0",
          utilizationPercent: 50,
          memoryUsedBytes: 1_000,
          memoryTotalBytes: 8_000,
          temperatureC: 40,
        },
      ],
    }),
    sample({
      disks: [
        {
          name: "nvme0n1",
          utilPercent: 30,
          readBytesPerSec: 300,
          writeBytesPerSec: null,
        },
        {
          name: "sda",
          utilPercent: 5,
          readBytesPerSec: 0,
          writeBytesPerSec: 0,
        },
      ],
      gpus: [
        {
          id: "0",
          utilizationPercent: 70,
          memoryUsedBytes: 3_000,
          memoryTotalBytes: 8_000,
          temperatureC: 44,
        },
      ],
    }),
  ]);

  assert.ok(averaged);
  assert.deepEqual(averaged.disks[0], {
    name: "nvme0n1",
    utilPercent: 20,
    readBytesPerSec: 200,
    writeBytesPerSec: null,
  });
  assert.equal(averaged.disks[1]?.name, "sda");
  assert.deepEqual(averaged.gpus[0], {
    id: "0",
    utilizationPercent: 60,
    memoryUsedBytes: 2_000,
    memoryTotalBytes: 8_000,
    temperatureC: 42,
  });
});

test("averageSamples returns null for an empty window", () => {
  assert.equal(averageSamples([]), null);
});

test("the recorder caps the live buffer at the tier capacity", () => {
  let clock = 0;
  const recorder = new SystemMetricsRecorder({ now: () => (clock += 1_000) });
  const ticks = SYSTEM_METRICS_TIERS.live.capacity + 25;
  for (let index = 0; index < ticks; index += 1) {
    recorder.tick();
  }

  const live = recorder.history("live");
  assert.equal(live.samples.length, SYSTEM_METRICS_TIERS.live.capacity);
  assert.equal(live.intervalMs, 1_000);
  const first = live.samples[0]!;
  const last = live.samples[live.samples.length - 1]!;
  assert.ok(last.at > first.at);
  recorder.reset();
});

test("the recorder folds live ticks into the coarse tiers", () => {
  let clock = 0;
  const recorder = new SystemMetricsRecorder({ now: () => (clock += 1_000) });
  for (let index = 0; index < 120; index += 1) {
    recorder.tick();
  }

  const hour = recorder.history("hour");
  const day = recorder.history("day");
  assert.equal(hour.intervalMs, 10_000);
  assert.equal(hour.samples.length, 12);
  assert.equal(day.intervalMs, 60_000);
  assert.equal(day.samples.length, 2);
  recorder.reset();
});

test("the recorder emits closed coarse buckets with their bucket start", () => {
  let clock = 0;
  const recorder = new SystemMetricsRecorder({ now: () => (clock += 1_000) });
  const seen: Array<{ window: string; bucketAt: number; at: number }> = [];
  const unsubscribe = recorder.subscribeCoarse((entry) =>
    seen.push({
      window: entry.window,
      bucketAt: entry.bucketAt,
      at: entry.sample.at,
    }),
  );

  for (let index = 0; index < 25; index += 1) {
    recorder.tick();
  }

  assert.deepEqual(
    seen.map((entry) => [entry.window, entry.bucketAt]),
    [
      ["hour", 0],
      ["hour", 10_000],
    ],
  );
  assert.equal(seen[0]?.at, 9_000);

  unsubscribe();
  for (let index = 0; index < 10; index += 1) {
    recorder.tick();
  }
  assert.equal(seen.length, 2);
  recorder.reset();
});

test("seed preloads a tier up to its capacity", () => {
  const recorder = new SystemMetricsRecorder({ now: () => 0 });
  const capacity = SYSTEM_METRICS_TIERS.day.capacity;
  const samples = Array.from({ length: capacity + 5 }, (_, index) =>
    sample({ at: (index + 1) * 60_000 }),
  );
  recorder.seed("day", samples);

  const day = recorder.history("day");
  assert.equal(day.samples.length, capacity);
  assert.equal(day.samples[0]?.at, 6 * 60_000);
  assert.equal(
    day.samples[day.samples.length - 1]?.at,
    (capacity + 5) * 60_000,
  );
});

test("the recorder fans samples out to subscribers until unsubscribed", () => {
  let clock = 0;
  const recorder = new SystemMetricsRecorder({ now: () => (clock += 1_000) });
  const seen: number[] = [];
  const unsubscribe = recorder.subscribe((entry) => seen.push(entry.at));

  recorder.tick();
  recorder.tick();
  unsubscribe();
  recorder.tick();

  assert.equal(seen.length, 2);
  recorder.reset();
});
