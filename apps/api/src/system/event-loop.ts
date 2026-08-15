import type {
  EventLoopBlockingSection,
  EventLoopReport,
  EventLoopStall,
} from "@arriero/core";
import { monitorEventLoopDelay } from "node:perf_hooks";

const STALL_THRESHOLD_MS = 250;
const SECTION_THRESHOLD_MS = 50;
const STALL_CAPACITY = 100;
const SECTION_CAPACITY = 200;
const CULPRIT_WINDOW_SLACK_MS = 2_000;
const CULPRITS_PER_STALL = 5;

export type EventLoopLagSource = {
  enable: () => void;
  readMaxMs: () => number | null;
};

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
};

type EventLoopStallListener = (stall: EventLoopStall) => void;

export class EventLoopMonitor {
  private readonly stallThresholdMs: number;
  private readonly sectionThresholdMs: number;
  private readonly sections: EventLoopBlockingSection[] = [];
  private readonly stalls: EventLoopStall[] = [];
  private readonly listeners = new Set<EventLoopStallListener>();

  constructor(
    private readonly lagSource: EventLoopLagSource,
    options: EventLoopMonitorOptions = {},
  ) {
    this.stallThresholdMs = options.stallThresholdMs ?? STALL_THRESHOLD_MS;
    this.sectionThresholdMs =
      options.sectionThresholdMs ?? SECTION_THRESHOLD_MS;
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
    if (this.sections.length > SECTION_CAPACITY) {
      this.sections.splice(0, this.sections.length - SECTION_CAPACITY);
    }
  }

  sample(at: number): number | null {
    const maxLagMs = this.lagSource.readMaxMs();
    if (maxLagMs === null || maxLagMs < this.stallThresholdMs) {
      return maxLagMs;
    }
    const stall: EventLoopStall = {
      detectedAt: at,
      durationMs: maxLagMs,
      culprits: this.culpritsFor(at, maxLagMs),
    };
    this.stalls.push(stall);
    if (this.stalls.length > STALL_CAPACITY) {
      this.stalls.splice(0, this.stalls.length - STALL_CAPACITY);
    }
    for (const listener of this.listeners) {
      listener(stall);
    }
    return maxLagMs;
  }

  private culpritsFor(
    at: number,
    durationMs: number,
  ): EventLoopBlockingSection[] {
    const windowStart = at - durationMs - CULPRIT_WINDOW_SLACK_MS;
    return this.sections
      .filter((section) => section.endedAt >= windowStart)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, CULPRITS_PER_STALL);
  }

  report(): EventLoopReport {
    return {
      stallThresholdMs: this.stallThresholdMs,
      sectionThresholdMs: this.sectionThresholdMs,
      stalls: [...this.stalls].reverse(),
      slowSections: [...this.sections].reverse(),
    };
  }
}

export const eventLoopMonitor = new EventLoopMonitor(
  createEventLoopLagSource(),
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
