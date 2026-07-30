import { strict as assert } from "node:assert";
import test from "node:test";

import { computeCpuActivity, type CpuCounters, parseProcStat } from "./cpu.js";

const SAMPLE = `cpu  100 10 50 800 20 5 5 10 0 0
cpu0 50 5 25 400 10 2 3 5 0 0
cpu1 50 5 25 400 10 3 2 5 0 0
intr 12345 0 0
ctxt 98765
`;

test("parseProcStat reads the aggregate line and every core line", () => {
  const counters = parseProcStat(SAMPLE);
  assert.ok(counters);
  assert.deepEqual(counters.total, {
    user: 100,
    nice: 10,
    system: 50,
    idle: 800,
    iowait: 20,
    irq: 5,
    softirq: 5,
    steal: 10,
  });
  assert.equal(counters.cores.size, 2);
  assert.equal(counters.cores.get(1)?.softirq, 2);
});

test("parseProcStat returns null without an aggregate cpu line", () => {
  assert.equal(parseProcStat("intr 1 2 3\nctxt 4\n"), null);
});

function counters(total: number[], cores: number[][]): CpuCounters {
  const toTimes = (values: number[]) => ({
    user: values[0]!,
    nice: values[1]!,
    system: values[2]!,
    idle: values[3]!,
    iowait: values[4]!,
    irq: values[5]!,
    softirq: values[6]!,
    steal: values[7]!,
  });
  return {
    total: toTimes(total),
    cores: new Map(cores.map((values, index) => [index, toTimes(values)])),
  };
}

test("computeCpuActivity derives busy share from the tick delta", () => {
  const activity = computeCpuActivity({
    previous: counters([0, 0, 0, 0, 0, 0, 0, 0], [[0, 0, 0, 0, 0, 0, 0, 0]]),
    current: counters(
      [200, 0, 100, 600, 100, 0, 0, 0],
      [[200, 0, 100, 600, 100, 0, 0, 0]],
    ),
    intervalMs: 1_000,
    loadAverage: [1, 2, 3],
  });

  assert.equal(activity.usagePercent, 30);
  assert.equal(activity.userPercent, 20);
  assert.equal(activity.systemPercent, 10);
  assert.equal(activity.ioWaitPercent, 10);
  assert.equal(activity.intervalMs, 1_000);
  assert.deepEqual(activity.cores, [{ id: 0, usagePercent: 30 }]);
  assert.deepEqual(activity.loadAverage, [1, 2, 3]);
});

test("computeCpuActivity reports zero usage without a previous sample", () => {
  const activity = computeCpuActivity({
    previous: null,
    current: counters(
      [200, 0, 100, 600, 100, 0, 0, 0],
      [[200, 0, 100, 600, 100, 0, 0, 0]],
    ),
    intervalMs: 0,
    loadAverage: [0, 0, 0],
  });

  assert.equal(activity.usagePercent, 0);
  assert.equal(activity.intervalMs, null);
  assert.deepEqual(activity.cores, [{ id: 0, usagePercent: 0 }]);
});

test("computeCpuActivity ignores counter resets", () => {
  const activity = computeCpuActivity({
    previous: counters(
      [500, 0, 500, 500, 0, 0, 0, 0],
      [[500, 0, 500, 500, 0, 0, 0, 0]],
    ),
    current: counters([1, 0, 1, 1, 0, 0, 0, 0], [[1, 0, 1, 1, 0, 0, 0, 0]]),
    intervalMs: 1_000,
    loadAverage: [0, 0, 0],
  });

  assert.equal(activity.usagePercent, 0);
  assert.equal(activity.intervalMs, null);
});
