import type {
  EventLoopBlockingSection,
  EventLoopReport,
  EventLoopStall,
  EventLoopStallSignals,
  EventLoopStallVerdict,
} from "@arriero/core";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { RingBuffer } from "./ring-buffer.js";

const STALL_THRESHOLD_MS = 250;
const SECTION_THRESHOLD_MS = 50;
const STALL_CAPACITY = 100;
const SECTION_CAPACITY = 200;
const CULPRIT_WINDOW_SLACK_MS = 2_000;
const CULPRITS_PER_STALL = 5;
const STARVED_RUN_DELAY_SHARE = 0.5;
const SELF_SIGNAL_SHARE = 0.7;
const PAGING_MAJOR_FAULTS_MIN = 16;

export type EventLoopLagSource = {
  enable: () => void;
  readMaxMs: () => number | null;
};

export type EventLoopSignalCounters = {
  cpuMs: number;
  runDelayMs: number;
  eluActiveMs: number;
  majorPageFaults: number;
};

export type EventLoopSignalsSource = () => EventLoopSignalCounters | null;

function readThreadSchedstat(): { cpuMs: number; runDelayMs: number } | null {
  try {
    const fields = readFileSync("/proc/thread-self/schedstat", "utf8")
      .trim()
      .split(/\s+/);
    const cpuNs = Number(fields[0]);
    const runDelayNs = Number(fields[1]);
    if (!Number.isFinite(cpuNs) || !Number.isFinite(runDelayNs)) {
      return null;
    }
    return { cpuMs: cpuNs / 1e6, runDelayMs: runDelayNs / 1e6 };
  } catch {
    return null;
  }
}

function createEventLoopSignalsSource(): EventLoopSignalsSource {
  return () => {
    const schedstat = readThreadSchedstat();
    if (schedstat === null) {
      return null;
    }
    return {
      cpuMs: schedstat.cpuMs,
      runDelayMs: schedstat.runDelayMs,
      eluActiveMs: performance.eventLoopUtilization().active,
      majorPageFaults: process.resourceUsage().majorPageFault,
    };
  };
}

function signalDelta(current: number, previous: number): number {
  return Math.max(0, Math.round((current - previous) * 10) / 10);
}

function classifyStall(
  durationMs: number,
  signals: EventLoopStallSignals | null,
): EventLoopStallVerdict {
  if (signals === null) {
    return "unknown";
  }
  if (signals.runDelayMs >= durationMs * STARVED_RUN_DELAY_SHARE) {
    return "starved";
  }
  if (signals.cpuMs >= durationMs * SELF_SIGNAL_SHARE) {
    return "self-cpu";
  }
  if (signals.eluActiveMs >= durationMs * SELF_SIGNAL_SHARE) {
    return signals.majorPageFaults >= PAGING_MAJOR_FAULTS_MIN
      ? "paging"
      : "self-wait";
  }
  return "unknown";
}

function createEventLoopLagSource(): EventLoopLagSource {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  return {
    enable: () => {
      histogram.enable();
    },
    readMaxMs: () => {
      const maxNs = histogram.max;
      histogram.reset();
      return maxNs > 0 ? maxNs / 1e6 : null;
    },
  };
}

type EventLoopMonitorOptions = {
  stallThresholdMs?: number;
  sectionThresholdMs?: number;
  signalsSource?: EventLoopSignalsSource;
};

type EventLoopStallListener = (stall: EventLoopStall) => void;

export class EventLoopMonitor {
  private readonly stallThresholdMs: number;
  private readonly sectionThresholdMs: number;
  private readonly signalsSource: EventLoopSignalsSource | null;
  private previousSignals: EventLoopSignalCounters | null = null;
  private readonly sections = new RingBuffer<EventLoopBlockingSection>(
    SECTION_CAPACITY,
  );
  private readonly stalls = new RingBuffer<EventLoopStall>(STALL_CAPACITY);
  private readonly listeners = new Set<EventLoopStallListener>();

  constructor(
    private readonly lagSource: EventLoopLagSource,
    options: EventLoopMonitorOptions = {},
  ) {
    this.stallThresholdMs = options.stallThresholdMs ?? STALL_THRESHOLD_MS;
    this.sectionThresholdMs =
      options.sectionThresholdMs ?? SECTION_THRESHOLD_MS;
    this.signalsSource = options.signalsSource ?? null;
  }

  enable() {
    this.lagSource.enable();
  }

  onStall(listener: EventLoopStallListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  recordBlockingSection(section: EventLoopBlockingSection) {
    if (section.durationMs < this.sectionThresholdMs) {
      return;
    }
    this.sections.push(section);
  }

  sample(at: number): number | null {
    const signals = this.advanceSignalsWindow();
    const maxLagMs = this.lagSource.readMaxMs();
    if (maxLagMs === null || maxLagMs < this.stallThresholdMs) {
      return maxLagMs;
    }
    const stall: EventLoopStall = {
      detectedAt: at,
      durationMs: maxLagMs,
      verdict: classifyStall(maxLagMs, signals),
      signals,
      culprits: this.culpritsFor(at, maxLagMs),
    };
    this.stalls.push(stall);
    for (const listener of this.listeners) {
      listener(stall);
    }
    return maxLagMs;
  }

  private advanceSignalsWindow(): EventLoopStallSignals | null {
    const current = this.signalsSource?.() ?? null;
    if (current === null) {
      this.previousSignals = null;
      return null;
    }
    const previous = this.previousSignals;
    this.previousSignals = current;
    if (previous === null) {
      return null;
    }
    return {
      cpuMs: signalDelta(current.cpuMs, previous.cpuMs),
      runDelayMs: signalDelta(current.runDelayMs, previous.runDelayMs),
      eluActiveMs: signalDelta(current.eluActiveMs, previous.eluActiveMs),
      majorPageFaults: Math.max(
        0,
        current.majorPageFaults - previous.majorPageFaults,
      ),
    };
  }

  private culpritsFor(
    at: number,
    durationMs: number,
  ): EventLoopBlockingSection[] {
    const windowStart = at - durationMs - CULPRIT_WINDOW_SLACK_MS;
    return this.sections
      .toArray()
      .filter((section) => section.endedAt >= windowStart)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, CULPRITS_PER_STALL);
  }

  report(): EventLoopReport {
    return {
      stallThresholdMs: this.stallThresholdMs,
      sectionThresholdMs: this.sectionThresholdMs,
      stalls: this.stalls.toArray().reverse(),
      slowSections: this.sections.toArray().reverse(),
    };
  }
}

export const eventLoopMonitor = new EventLoopMonitor(
  createEventLoopLagSource(),
  { signalsSource: createEventLoopSignalsSource() },
);

export function traceBlockingSection<T>(label: string, fn: () => T): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const endedAt = performance.now();
    eventLoopMonitor.recordBlockingSection({
      label,
      durationMs: endedAt - startedAt,
      endedAt: Date.now(),
    });
  }
}
