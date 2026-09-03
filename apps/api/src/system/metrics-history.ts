import {
  SYSTEM_METRICS_TIERS,
  SystemMetricsCoarseWindowSchema,
  type SystemCpuActivity,
  type SystemDiskActivity,
  type SystemMetricsCoarseWindow,
  type SystemMetricsDiskSample,
  type SystemMetricsGpuSample,
  type SystemMetricsHistory,
  type SystemMetricsNetworkSample,
  type SystemMetricsRdmaSample,
  type SystemMetricsSample,
  type SystemMetricsWindow,
  type SystemNetworkActivity,
  type SystemRdmaActivity,
} from "@arriero/core";

import { nvidiaTelemetry } from "../nvidia/telemetry.js";
import { eventLoopMonitor } from "./event-loop.js";
import { RingBuffer } from "./ring-buffer.js";
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
import {
  computeRdmaActivity,
  type RdmaCounters,
  readRdmaCounters,
} from "./rdma.js";

export const COARSE_METRICS_WINDOWS = SystemMetricsCoarseWindowSchema.options;

const COARSE_TIER_SOURCES: Record<
  SystemMetricsCoarseWindow,
  SystemMetricsWindow
> = {
  hour: "live",
  day: "live",
  month: "day",
};

function averageNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function maxNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return Math.max(...present);
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

function averageRdma(
  samples: SystemMetricsSample[],
): SystemMetricsRdmaSample | null {
  const latest = samples.findLast((sample) => sample.rdma !== null)?.rdma;
  if (!latest) {
    return null;
  }
  const matching = samples.flatMap((sample) =>
    sample.rdma?.device === latest.device && sample.rdma.port === latest.port
      ? [sample.rdma]
      : [],
  );
  return {
    device: latest.device,
    port: latest.port,
    receiveBytesPerSec: averageNullable(
      matching.map((sample) => sample.receiveBytesPerSec),
    ),
    transmitBytesPerSec: averageNullable(
      matching.map((sample) => sample.transmitBytesPerSec),
    ),
  };
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
    cpuStealPercent: averageNullable(
      samples.map((sample) => sample.cpuStealPercent),
    ),
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
    rdma: averageRdma(samples),
    eventLoopMaxLagMs: maxNullable(
      samples.map((sample) => sample.eventLoopMaxLagMs),
    ),
  };
}

export type SystemMetricsSnapshot = {
  cpu: SystemCpuActivity | null;
  network: SystemNetworkActivity | null;
  disk: SystemDiskActivity | null;
  rdma: SystemRdmaActivity | null;
};

type SystemMetricsListener = (sample: SystemMetricsSample) => void;

type SystemMetricsCoarseSample = {
  window: SystemMetricsCoarseWindow;
  bucketAt: number;
  sample: SystemMetricsSample;
};

type SystemMetricsCoarseListener = (entry: SystemMetricsCoarseSample) => void;

type SystemMetricsHistoryOptions = {
  now?: () => number;
  sampleEventLoopMaxLagMs?: (at: number) => number | null;
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
  private readonly sampleEventLoopMaxLagMs:
    | ((at: number) => number | null)
    | null;
  private readonly buffers = new Map<
    SystemMetricsWindow,
    RingBuffer<SystemMetricsSample>
  >();
  private readonly pending = new Map<
    SystemMetricsCoarseWindow,
    { bucket: number; samples: SystemMetricsSample[] }
  >();
  private readonly listeners = new Set<SystemMetricsListener>();
  private readonly coarseListeners = new Set<SystemMetricsCoarseListener>();
  private timer: NodeJS.Timeout | null = null;
  private previousCpu: CpuCounters | null = null;
  private previousNet: Map<string, NetCounters> | null = null;
  private previousDisk: Map<string, DiskCounters> | null = null;
  private previousRdma: RdmaCounters | null = null;
  private previousAt: number | null = null;
  private snapshot: SystemMetricsSnapshot = {
    cpu: null,
    network: null,
    disk: null,
    rdma: null,
  };

  constructor(options: SystemMetricsHistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sampleEventLoopMaxLagMs = options.sampleEventLoopMaxLagMs ?? null;
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
    this.coarseListeners.clear();
    this.previousCpu = null;
    this.previousNet = null;
    this.previousDisk = null;
    this.previousRdma = null;
    this.previousAt = null;
    this.snapshot = { cpu: null, network: null, disk: null, rdma: null };
  }

  subscribe(listener: SystemMetricsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCoarse(listener: SystemMetricsCoarseListener): () => void {
    this.coarseListeners.add(listener);
    return () => {
      this.coarseListeners.delete(listener);
    };
  }

  seed(window: SystemMetricsCoarseWindow, samples: SystemMetricsSample[]) {
    const buffer = this.buffers.get(window);
    if (!buffer) {
      return;
    }
    for (const sample of samples) {
      buffer.push(sample);
    }
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

    const rdmaCounters = readRdmaCounters(at);
    const rdma = rdmaCounters
      ? computeRdmaActivity({
          previous: this.previousRdma,
          current: rdmaCounters,
          intervalMs,
        })
      : null;
    this.previousRdma = rdmaCounters;

    const memory = readSystemMemory();
    this.previousAt = at;
    this.snapshot = { cpu, network, disk, rdma };

    const sample: SystemMetricsSample = {
      at,
      cpuPercent: cpu?.usagePercent ?? null,
      cpuStealPercent: cpu?.stealPercent ?? null,
      memoryUsedBytes: memory.usedBytes,
      memoryTotalBytes: memory.totalBytes,
      gpus: gpuSamples(),
      disks: diskSamples(disk),
      network: networkSamples(network),
      rdma: rdma
        ? {
            device: rdma.device,
            port: rdma.port,
            receiveBytesPerSec: rdma.receiveBytesPerSec,
            transmitBytesPerSec: rdma.transmitBytesPerSec,
          }
        : null,
      eventLoopMaxLagMs: this.sampleEventLoopMaxLagMs?.(at) ?? null,
    };

    this.buffers.get("live")?.push(sample);
    this.accumulate(sample);
    for (const listener of this.listeners) {
      listener(sample);
    }
  }

  private accumulate(sample: SystemMetricsSample) {
    const closed = new Map<SystemMetricsWindow, SystemMetricsSample>([
      ["live", sample],
    ]);
    for (const window of COARSE_METRICS_WINDOWS) {
      const source = closed.get(COARSE_TIER_SOURCES[window]);
      if (!source) {
        continue;
      }
      const averaged = this.fold(window, source);
      if (averaged) {
        closed.set(window, averaged);
      }
    }
  }

  private fold(
    window: SystemMetricsCoarseWindow,
    sample: SystemMetricsSample,
  ): SystemMetricsSample | null {
    const intervalMs = SYSTEM_METRICS_TIERS[window].intervalMs;
    const bucket = Math.floor(sample.at / intervalMs);
    const pending = this.pending.get(window);
    if (!pending) {
      this.pending.set(window, { bucket, samples: [sample] });
      return null;
    }
    if (pending.bucket === bucket) {
      pending.samples.push(sample);
      return null;
    }
    const averaged = averageSamples(pending.samples);
    if (averaged) {
      this.buffers.get(window)?.push(averaged);
      const entry: SystemMetricsCoarseSample = {
        window,
        bucketAt: pending.bucket * intervalMs,
        sample: averaged,
      };
      for (const listener of this.coarseListeners) {
        listener(entry);
      }
    }
    this.pending.set(window, { bucket, samples: [sample] });
    return averaged;
  }
}

export const systemMetricsRecorder = new SystemMetricsRecorder({
  sampleEventLoopMaxLagMs: (at) => eventLoopMonitor.sample(at),
});
