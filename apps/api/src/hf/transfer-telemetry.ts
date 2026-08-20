import type { HfDownloadTransfer } from "@arriero/core";

const MIN_SAMPLE_MS = 300;
const EWMA_TIME_CONSTANT_MS = 5_000;
const STALL_MS = 6_000;

export type HfTransferTelemetry = {
  startedAt: number;
  wireBytes: number;
  payloadBytes: number;
  resetCount: number;
  lastProgressAt: number;
  ewmaBps: number | null;
  lastSampleAt: number | null;
  lastSamplePayload: number;
};

export function createHfTransferTelemetry(now: number): HfTransferTelemetry {
  return {
    startedAt: now,
    wireBytes: 0,
    payloadBytes: 0,
    resetCount: 0,
    lastProgressAt: now,
    ewmaBps: null,
    lastSampleAt: null,
    lastSamplePayload: 0,
  };
}

export function recordHfTransferWire(
  telemetry: HfTransferTelemetry,
  deltaBytes: number,
  now: number,
): void {
  if (deltaBytes <= 0) {
    return;
  }
  telemetry.wireBytes += deltaBytes;
  telemetry.lastProgressAt = now;
}

export function recordHfTransferReset(telemetry: HfTransferTelemetry): void {
  telemetry.resetCount += 1;
}

export function recordHfTransferPayload(
  telemetry: HfTransferTelemetry,
  deltaBytes: number,
  now: number,
): void {
  if (deltaBytes <= 0) {
    return;
  }
  telemetry.payloadBytes += deltaBytes;
  if (telemetry.lastSampleAt === null) {
    telemetry.lastSampleAt = now;
    telemetry.lastSamplePayload = telemetry.payloadBytes;
    return;
  }
  const dt = now - telemetry.lastSampleAt;
  if (dt < MIN_SAMPLE_MS) {
    return;
  }
  const sampleDelta = telemetry.payloadBytes - telemetry.lastSamplePayload;
  const instant = (sampleDelta * 1_000) / dt;
  const alpha = 1 - Math.exp(-dt / EWMA_TIME_CONSTANT_MS);
  telemetry.ewmaBps =
    telemetry.ewmaBps === null
      ? instant
      : telemetry.ewmaBps + alpha * (instant - telemetry.ewmaBps);
  telemetry.lastSampleAt = now;
  telemetry.lastSamplePayload = telemetry.payloadBytes;
}

export function hfTransferSnapshot(
  telemetry: HfTransferTelemetry,
  remainingBytes: number,
  now: number,
): HfDownloadTransfer {
  const sinceProgressMs = now - telemetry.lastProgressAt;
  const stalled = sinceProgressMs >= STALL_MS;
  const payloadBps = stalled ? null : telemetry.ewmaBps;
  const etaSeconds =
    payloadBps !== null && payloadBps > 0 && remainingBytes > 0
      ? Math.round(remainingBytes / payloadBps)
      : null;
  return {
    payloadBps,
    etaSeconds,
    wireBytes: telemetry.wireBytes,
    wastedBytes: Math.max(0, telemetry.wireBytes - telemetry.payloadBytes),
    resetCount: telemetry.resetCount,
    lastProgressAt: new Date(telemetry.lastProgressAt).toISOString(),
    stalledSeconds: stalled ? Math.floor(sinceProgressMs / 1_000) : null,
  };
}
