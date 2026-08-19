export type ByteRate = {
  bps: number | null;
  stalled: boolean;
};

type RateTracker = {
  lastBytes: number;
  lastAt: number;
  lastMovementAt: number;
  ewmaBps: number | null;
};

const STALL_MS = 6_000;
const MIN_SAMPLE_MS = 300;
const EWMA_TIME_CONSTANT_MS = 5_000;

const trackers = new Map<string, RateTracker>();

export function recordRateSample(id: string, bytes: number, now: number): void {
  const tracker = trackers.get(id);
  if (!tracker || bytes < tracker.lastBytes) {
    trackers.set(id, {
      lastBytes: bytes,
      lastAt: now,
      lastMovementAt: now,
      ewmaBps: null,
    });
    return;
  }
  const dt = now - tracker.lastAt;
  if (dt < MIN_SAMPLE_MS) {
    return;
  }
  const delta = bytes - tracker.lastBytes;
  if (delta === 0 && dt < 1_000) {
    return;
  }
  const instant = (delta * 1_000) / dt;
  const alpha = 1 - Math.exp(-dt / EWMA_TIME_CONSTANT_MS);
  tracker.ewmaBps =
    tracker.ewmaBps === null
      ? instant
      : tracker.ewmaBps + alpha * (instant - tracker.ewmaBps);
  tracker.lastBytes = bytes;
  tracker.lastAt = now;
  if (delta > 0) {
    tracker.lastMovementAt = now;
  }
}

export function currentByteRate(id: string, now: number): ByteRate {
  const tracker = trackers.get(id);
  if (!tracker || tracker.ewmaBps === null) {
    return { bps: null, stalled: false };
  }
  const stalled = now - tracker.lastMovementAt > STALL_MS;
  return { bps: stalled ? null : tracker.ewmaBps, stalled };
}

export function dropByteRate(id: string): void {
  trackers.delete(id);
}
