import {
  SYSTEM_METRICS_TIERS,
  type SystemCpuActivity,
  type SystemDiskActivity,
  type SystemMetricsDiskSample,
  type SystemMetricsGpuSample,
  type SystemMetricsHistory,
  type SystemMetricsNetworkSample,
  type SystemMetricsSample,
  type SystemMetricsWindow,
  type SystemNetworkActivity,
} from "@arriero/core";

import { nvidiaTelemetry } from "../nvidia/telemetry.js";
import {
  computeCpuActivity,
  type CpuCounters,
  readCpuCounters,
  readLoadAverage,
} from "./cpu.js";
import {
  buildDiskActivity,
  type DiskCounters,
  readDiskCounters,
} from "./disk.js";
import { readSystemMemory } from "./memory.js";
import {
  buildNetworkActivity,
  type NetCounters,
  readNetCounters,
} from "./net.js";

const COARSE_WINDOWS: SystemMetricsWindow[] = ["hour", "day"];

class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  clear() {
    this.items.length = 0;
  }
}

function averageNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function averageBy<T, R>(
  groups: T[][],
  key: (item: T) => string,
  merge: (id: string, items: T[]) => R,
): R[] {
  const buckets = new Map<string, T[]>();
  for (const group of groups) {
    for (const item of group) {
      const id = key(item);
      const bucket = buckets.get(id);
      if (bucket) {
        bucket.push(item);
      } else {
        buckets.set(id, [item]);
      }
    }
  }
  return [...buckets.entries()].map(([id, items]) => merge(id, items));
}

export function averageSamples(
  samples: SystemMetricsSample[],
): SystemMetricsSample | null {
  if (samples.length === 0) {
    return null;
  }
  const last = samples[samples.length - 1]!;

  return {
    at: last.at,
    cpuPercent: averageNullable(samples.map((sample) => sample.cpuPercent)),
    memoryUsedBytes:
      samples.reduce((sum, sample) => sum + sample.memoryUsedBytes, 0) /
      samples.length,
    memoryTotalBytes: last.memoryTotalBytes,
    gpus: averageBy(
      samples.map((sample) => sample.gpus),
      (gpu) => gpu.id,
      (id, items) => ({
        id,
        utilizationPercent: averageNullable(
          items.map((item) => item.utilizationPercent),
        ),
        memoryUsedBytes: averageNullable(
          items.map((item) => item.memoryUsedBytes),
        ),
        memoryTotalBytes: items[items.length - 1]!.memoryTotalBytes,
        temperatureC: averageNullable(items.map((item) => item.temperatureC)),
      }),
    ),
    disks: averageBy(
      samples.map((sample) => sample.disks),
      (disk) => disk.name,
      (name, items) => ({
        name,
        utilPercent: averageNullable(items.map((item) => item.utilPercent)),
        readBytesPerSec: averageNullable(
          items.map((item) => item.readBytesPerSec),
        ),
        writeBytesPerSec: averageNullable(
          items.map((item) => item.writeBytesPerSec),
        ),
      }),
    ),
    network: averageBy(
      samples.map((sample) => sample.network),
      (entry) => entry.name,
      (name, items) => ({
        name,
        rxBytesPerSec: averageNullable(items.map((item) => item.rxBytesPerSec)),
        txBytesPerSec: averageNullable(items.map((item) => item.txBytesPerSec)),
      }),
    ),
  };
}

export type SystemMetricsSnapshot = {
  cpu: SystemCpuActivity | null;
  network: SystemNetworkActivity | null;
  disk: SystemDiskActivity | null;
};

type SystemMetricsListener = (sample: SystemMetricsSample) => void;

type SystemMetricsHistoryOptions = {
  now?: () => number;
};

function gpuSamples(): SystemMetricsGpuSample[] {
  return nvidiaTelemetry.accelerators().map((device) => ({
    id: String(device.index),
    utilizationPercent: device.utilizationPercent,
    memoryUsedBytes: device.usedMemoryBytes,
    memoryTotalBytes: device.totalMemoryBytes,
    temperatureC: device.temperatureC,
  }));
}

function diskSamples(
  disk: SystemDiskActivity | null,
): SystemMetricsDiskSample[] {
  return (disk?.devices ?? []).map((device) => ({
    name: device.name,
    utilPercent: device.utilPercent,
    readBytesPerSec: device.readBytesPerSec,
    writeBytesPerSec: device.writeBytesPerSec,
  }));
}

function networkSamples(
  network: SystemNetworkActivity | null,
): SystemMetricsNetworkSample[] {
  return (network?.interfaces ?? []).map((entry) => ({
    name: entry.name,
    rxBytesPerSec: entry.rxBytesPerSec,
    txBytesPerSec: entry.txBytesPerSec,
  }));
}

export class SystemMetricsRecorder {
  private readonly now: () => number;
  private readonly buffers = new Map<
    SystemMetricsWindow,
    RingBuffer<SystemMetricsSample>
  >();
  private readonly pending = new Map<
    SystemMetricsWindow,
    { bucket: number; samples: SystemMetricsSample[] }
  >();
  private readonly listeners = new Set<SystemMetricsListener>();
  private timer: NodeJS.Timeout | null = null;
  private previousCpu: CpuCounters | null = null;
  private previousNet: Map<string, NetCounters> | null = null;
  private previousDisk: Map<string, DiskCounters> | null = null;
  private previousAt: number | null = null;
  private snapshot: SystemMetricsSnapshot = {
    cpu: null,
    network: null,
    disk: null,
  };

  constructor(options: SystemMetricsHistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    for (const [window, tier] of Object.entries(SYSTEM_METRICS_TIERS)) {
      this.buffers.set(
        window as SystemMetricsWindow,
        new RingBuffer(tier.capacity),
      );
    }
  }

  start() {
    if (this.timer) {
      return;
    }
    if (this.previousAt === null) {
      this.tick();
    }
    this.timer = setInterval(
      () => this.tick(),
      SYSTEM_METRICS_TIERS.live.intervalMs,
    );
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset() {
    this.stop();
    for (const buffer of this.buffers.values()) {
      buffer.clear();
    }
    this.pending.clear();
    this.listeners.clear();
    this.previousCpu = null;
    this.previousNet = null;
    this.previousDisk = null;
    this.previousAt = null;
    this.snapshot = { cpu: null, network: null, disk: null };
  }

  subscribe(listener: SystemMetricsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  current(): SystemMetricsSnapshot {
    return this.snapshot;
  }

  history(window: SystemMetricsWindow): SystemMetricsHistory {
    const tier = SYSTEM_METRICS_TIERS[window];
    return {
      window,
      intervalMs: tier.intervalMs,
      capacity: tier.capacity,
      samples: this.buffers.get(window)?.toArray() ?? [],
    };
  }

  tick() {
    const at = this.now();
    const intervalMs = this.previousAt === null ? 0 : at - this.previousAt;

    const cpuCounters = readCpuCounters();
    const cpu = cpuCounters
      ? computeCpuActivity({
          previous: this.previousCpu,
          current: cpuCounters,
          intervalMs,
          loadAverage: readLoadAverage(),
        })
      : null;
    this.previousCpu = cpuCounters;

    const netCounters = readNetCounters();
    const network = netCounters
      ? buildNetworkActivity({
          previous: this.previousNet,
          current: netCounters,
          intervalMs,
          now: at,
        })
      : null;
    this.previousNet = netCounters;

    const diskCounters = readDiskCounters();
    const disk = diskCounters
      ? buildDiskActivity({
          previous: this.previousDisk,
          current: diskCounters,
          intervalMs,
        })
      : null;
    this.previousDisk = diskCounters;

    const memory = readSystemMemory();
    this.previousAt = at;
    this.snapshot = { cpu, network, disk };

    const sample: SystemMetricsSample = {
      at,
      cpuPercent: cpu?.usagePercent ?? null,
      memoryUsedBytes: memory.usedBytes,
      memoryTotalBytes: memory.totalBytes,
      gpus: gpuSamples(),
      disks: diskSamples(disk),
      network: networkSamples(network),
    };

    this.buffers.get("live")?.push(sample);
    this.accumulate(sample);
    for (const listener of this.listeners) {
      listener(sample);
    }
  }

  private accumulate(sample: SystemMetricsSample) {
    for (const window of COARSE_WINDOWS) {
      const bucket = Math.floor(
        sample.at / SYSTEM_METRICS_TIERS[window].intervalMs,
      );
      const pending = this.pending.get(window);
      if (!pending) {
        this.pending.set(window, { bucket, samples: [sample] });
        continue;
      }
      if (pending.bucket === bucket) {
        pending.samples.push(sample);
        continue;
      }
      const averaged = averageSamples(pending.samples);
      if (averaged) {
        this.buffers.get(window)?.push(averaged);
      }
      this.pending.set(window, { bucket, samples: [sample] });
    }
  }
}

export const systemMetricsRecorder = new SystemMetricsRecorder();
