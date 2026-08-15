import assert from "node:assert/strict";
import { test } from "node:test";

import { EventLoopMonitor, type EventLoopLagSource } from "./event-loop.js";

function fakeLagSource(values: (number | null)[]): EventLoopLagSource {
  const queue = [...values];
  return {
    enable: () => undefined,
    readMaxMs: () => queue.shift() ?? null,
  };
}

test("sample below the stall threshold records no stall", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([40, null, 120]), {
    stallThresholdMs: 250,
  });
  assert.equal(monitor.sample(1_000), 40);
  assert.equal(monitor.sample(2_000), null);
  assert.equal(monitor.sample(3_000), 120);
  assert.deepEqual(monitor.report().stalls, []);
});

test("a stall captures overlapping blocking sections as culprits", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([1_800]), {
    stallThresholdMs: 250,
    sectionThresholdMs: 50,
  });
  monitor.recordBlockingSection({
    label: "git:status",
    durationMs: 1_700,
    endedAt: 9_900,
  });
  monitor.recordBlockingSection({
    label: "uv:version",
    durationMs: 80,
    endedAt: 9_950,
  });
  monitor.recordBlockingSection({
    label: "help:llama-server",
    durationMs: 400,
    endedAt: 3_000,
  });

  const lag = monitor.sample(10_000);
  assert.equal(lag, 1_800);
  const stalls = monitor.report().stalls;
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]?.durationMs, 1_800);
  assert.deepEqual(
    stalls[0]?.culprits.map((culprit) => culprit.label),
    ["git:status", "uv:version"],
  );
});

test("sections shorter than the threshold are not recorded", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([300]), {
    stallThresholdMs: 250,
    sectionThresholdMs: 50,
  });
  monitor.recordBlockingSection({
    label: "git:status",
    durationMs: 10,
    endedAt: 990,
  });
  monitor.sample(1_000);
  assert.deepEqual(monitor.report().slowSections, []);
  assert.deepEqual(monitor.report().stalls[0]?.culprits, []);
});

test("a stall notifies listeners and the report is newest-first", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([300, 500]), {
    stallThresholdMs: 250,
  });
  const seen: number[] = [];
  monitor.onStall((stall) => seen.push(stall.durationMs));
  monitor.sample(1_000);
  monitor.sample(2_000);
  assert.deepEqual(seen, [300, 500]);
  assert.deepEqual(
    monitor.report().stalls.map((stall) => stall.detectedAt),
    [2_000, 1_000],
  );
});
