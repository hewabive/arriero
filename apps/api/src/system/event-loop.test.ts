import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EventLoopMonitor,
  type EventLoopLagSource,
  type EventLoopSignalCounters,
  type EventLoopSignalsSource,
} from "./event-loop.js";

function fakeLagSource(values: (number | null)[]): EventLoopLagSource {
  const queue = [...values];
  return {
    enable: () => undefined,
    readMaxMs: () => queue.shift() ?? null,
  };
}

function fakeSignalsSource(
  values: (EventLoopSignalCounters | null)[],
): EventLoopSignalsSource {
  const queue = [...values];
  return () => queue.shift() ?? null;
}

function counters(
  overrides: Partial<EventLoopSignalCounters>,
): EventLoopSignalCounters {
  return {
    cpuMs: 0,
    runDelayMs: 0,
    eluActiveMs: 0,
    majorPageFaults: 0,
    ...overrides,
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

test("a stall without a signals source stays unknown with null signals", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([300]), {
    stallThresholdMs: 250,
  });
  monitor.sample(1_000);
  const stall = monitor.report().stalls[0];
  assert.equal(stall?.verdict, "unknown");
  assert.equal(stall?.signals, null);
});

test("the first stall after boot has no delta window yet", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([counters({ runDelayMs: 900 })]),
  });
  monitor.sample(1_000);
  const stall = monitor.report().stalls[0];
  assert.equal(stall?.verdict, "unknown");
  assert.equal(stall?.signals, null);
});

test("dominant run delay attributes the stall to host contention", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([null, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({ cpuMs: 100, runDelayMs: 5, eluActiveMs: 50 }),
      counters({ cpuMs: 120, runDelayMs: 290, eluActiveMs: 340 }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  const stall = monitor.report().stalls[0];
  assert.equal(stall?.verdict, "starved");
  assert.deepEqual(stall?.signals, {
    cpuMs: 20,
    runDelayMs: 285,
    eluActiveMs: 290,
    majorPageFaults: 0,
  });
});

test("cpu burn close to the lag attributes the stall to own code", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([null, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({ cpuMs: 40, eluActiveMs: 10 }),
      counters({ cpuMs: 330, runDelayMs: 3, eluActiveMs: 305 }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  assert.equal(monitor.report().stalls[0]?.verdict, "self-cpu");
});

test("an active loop without cpu burn is an own sync wait", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([null, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({}),
      counters({
        cpuMs: 8,
        runDelayMs: 2,
        eluActiveMs: 290,
        majorPageFaults: 3,
      }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  assert.equal(monitor.report().stalls[0]?.verdict, "self-wait");
});

test("heavy major faults during an active wait mean paging", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([null, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({}),
      counters({
        cpuMs: 8,
        runDelayMs: 2,
        eluActiveMs: 290,
        majorPageFaults: 40,
      }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  assert.equal(monitor.report().stalls[0]?.verdict, "paging");
});

test("no dominant signal leaves the stall unknown", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([null, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({}),
      counters({ cpuMs: 30, runDelayMs: 20, eluActiveMs: 40 }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  assert.equal(monitor.report().stalls[0]?.verdict, "unknown");
});

test("the signal window advances on every sample, stall or not", () => {
  const monitor = new EventLoopMonitor(fakeLagSource([40, 40, 300]), {
    stallThresholdMs: 250,
    signalsSource: fakeSignalsSource([
      counters({ runDelayMs: 1_000 }),
      counters({ runDelayMs: 2_000 }),
      counters({ runDelayMs: 2_010 }),
    ]),
  });
  monitor.sample(1_000);
  monitor.sample(2_000);
  monitor.sample(3_000);
  const stall = monitor.report().stalls[0];
  assert.equal(stall?.signals?.runDelayMs, 10);
  assert.equal(stall?.verdict, "unknown");
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
