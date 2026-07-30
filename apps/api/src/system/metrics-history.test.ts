import type { SystemMetricsSample } from "@arriero/core";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  averageSamples,
  SYSTEM_METRICS_TIERS,
  SystemMetricsRecorder,
} from "./metrics-history.js";

function sample(input: Partial<SystemMetricsSample>): SystemMetricsSample {
  return {
    at: 0,
    cpuPercent: 0,
    cpuIoWaitPercent: 0,
    cpuCorePercents: [0],
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

test("averageSamples drops per-core detail from coarse tiers", () => {
  const averaged = averageSamples([sample({ cpuCorePercents: [10, 90] })]);
  assert.equal(averaged?.cpuCorePercents, null);
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
  assert.equal(hour.samples[0]?.cpuCorePercents, null);
  recorder.reset();
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
