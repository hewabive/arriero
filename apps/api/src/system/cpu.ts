import type { SystemCpuActivity, SystemCpuCore } from "@arriero/core";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";

export type CpuTimes = {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
};

export type CpuCounters = {
  total: CpuTimes;
  cores: Map<number, CpuTimes>;
};

const EMPTY_TIMES: CpuTimes = {
  user: 0,
  nice: 0,
  system: 0,
  idle: 0,
  iowait: 0,
  irq: 0,
  softirq: 0,
  steal: 0,
};

function parseTimes(fields: string[]): CpuTimes | null {
  const values = fields.map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    user: values[0] ?? 0,
    nice: values[1] ?? 0,
    system: values[2] ?? 0,
    idle: values[3] ?? 0,
    iowait: values[4] ?? 0,
    irq: values[5] ?? 0,
    softirq: values[6] ?? 0,
    steal: values[7] ?? 0,
  };
}

export function parseProcStat(contents: string): CpuCounters | null {
  let total: CpuTimes | null = null;
  const cores = new Map<number, CpuTimes>();

  for (const line of contents.split("\n")) {
    if (!line.startsWith("cpu")) {
      continue;
    }
    const fields = line.trim().split(/\s+/);
    const label = fields[0];
    if (!label) {
      continue;
    }
    const times = parseTimes(fields.slice(1));
    if (!times) {
      continue;
    }
    if (label === "cpu") {
      total = times;
      continue;
    }
    const id = Number(label.slice(3));
    if (Number.isInteger(id) && id >= 0) {
      cores.set(id, times);
    }
  }

  return total ? { total, cores } : null;
}

function totalTicks(times: CpuTimes): number {
  return (
    times.user +
    times.nice +
    times.system +
    times.idle +
    times.iowait +
    times.irq +
    times.softirq +
    times.steal
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function delta(current: CpuTimes, previous: CpuTimes): CpuTimes {
  return {
    user: current.user - previous.user,
    nice: current.nice - previous.nice,
    system: current.system - previous.system,
    idle: current.idle - previous.idle,
    iowait: current.iowait - previous.iowait,
    irq: current.irq - previous.irq,
    softirq: current.softirq - previous.softirq,
    steal: current.steal - previous.steal,
  };
}

function busyRatio(times: CpuTimes): number {
  const total = totalTicks(times);
  if (total <= 0) {
    return 0;
  }
  return (total - times.idle - times.iowait) / total;
}

export function computeCpuActivity(input: {
  previous: CpuCounters | null;
  current: CpuCounters;
  intervalMs: number;
  loadAverage: [number, number, number];
}): SystemCpuActivity {
  const previousTotal = input.previous?.total ?? EMPTY_TIMES;
  const usable =
    input.previous !== null &&
    totalTicks(input.current.total) > totalTicks(previousTotal);
  const totalDelta = usable
    ? delta(input.current.total, previousTotal)
    : EMPTY_TIMES;
  const totalDeltaTicks = totalTicks(totalDelta);
  const share = (ticks: number) =>
    totalDeltaTicks > 0 ? clampPercent((ticks / totalDeltaTicks) * 100) : 0;

  const cores: SystemCpuCore[] = [...input.current.cores.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, times]) => {
      const previousCore = input.previous?.cores.get(id);
      const coreDelta =
        usable && previousCore ? delta(times, previousCore) : EMPTY_TIMES;
      return { id, usagePercent: clampPercent(busyRatio(coreDelta) * 100) };
    });

  return {
    usagePercent: clampPercent(busyRatio(totalDelta) * 100),
    userPercent: share(totalDelta.user + totalDelta.nice),
    systemPercent: share(
      totalDelta.system + totalDelta.irq + totalDelta.softirq,
    ),
    ioWaitPercent: share(totalDelta.iowait),
    stealPercent: share(totalDelta.steal),
    cores,
    loadAverage: input.loadAverage,
    intervalMs: usable && input.intervalMs > 0 ? input.intervalMs : null,
  };
}

export function readCpuCounters(): CpuCounters | null {
  try {
    return parseProcStat(readFileSync("/proc/stat", "utf8"));
  } catch {
    return null;
  }
}

export function readLoadAverage(): [number, number, number] {
  const [one, five, fifteen] = loadavg();
  return [one ?? 0, five ?? 0, fifteen ?? 0];
}
