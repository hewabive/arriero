import type { SystemRdmaActivity } from "@arriero/core";
import { readdirSync, readFileSync } from "node:fs";

const INFINIBAND_CLASS_PATH = "/sys/class/infiniband";
const PORT_CACHE_MS = 30_000;
const COUNTER_UNIT_BYTES = 4n;

export type RdmaPort = {
  device: string;
  port: number;
};

export type RdmaCounters = RdmaPort & {
  receiveDataUnits: bigint;
  transmitDataUnits: bigint;
};

function directoryNames(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function readString(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function discoverActiveRdmaPorts(
  root = INFINIBAND_CLASS_PATH,
): RdmaPort[] {
  const ports: RdmaPort[] = [];
  for (const device of directoryNames(root)) {
    for (const entry of directoryNames(`${root}/${device}/ports`)) {
      const port = Number(entry);
      if (!Number.isInteger(port) || port < 1) {
        continue;
      }
      const base = `${root}/${device}/ports/${entry}`;
      if (!/\bACTIVE\b/.test(readString(`${base}/state`) ?? "")) {
        continue;
      }
      if (
        readString(`${base}/counters/port_rcv_data`) === null ||
        readString(`${base}/counters/port_xmit_data`) === null
      ) {
        continue;
      }
      ports.push({ device, port });
    }
  }
  return ports;
}

export function parseRdmaCounter(contents: string | null): bigint | null {
  const value = contents?.trim() ?? "";
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

export function readRdmaPortCounters(
  port: RdmaPort,
  root = INFINIBAND_CLASS_PATH,
): RdmaCounters | null {
  const base = `${root}/${port.device}/ports/${port.port}/counters`;
  const receiveDataUnits = parseRdmaCounter(
    readString(`${base}/port_rcv_data`),
  );
  const transmitDataUnits = parseRdmaCounter(
    readString(`${base}/port_xmit_data`),
  );
  return receiveDataUnits === null || transmitDataUnits === null
    ? null
    : { ...port, receiveDataUnits, transmitDataUnits };
}

let portCache: { expiresAt: number; value: RdmaPort | null } | null = null;

export function selectSingleRdmaPort(ports: RdmaPort[]): RdmaPort | null {
  return ports.length === 1 ? ports[0]! : null;
}

function selectedRdmaPort(now: number): RdmaPort | null {
  if (portCache && portCache.expiresAt > now) {
    return portCache.value;
  }
  const active = discoverActiveRdmaPorts();
  const value = selectSingleRdmaPort(active);
  portCache = { expiresAt: now + PORT_CACHE_MS, value };
  return value;
}

export function readRdmaCounters(now = Date.now()): RdmaCounters | null {
  if (process.platform !== "linux") {
    return null;
  }
  const port = selectedRdmaPort(now);
  return port ? readRdmaPortCounters(port) : null;
}

export function computeRdmaActivity(input: {
  previous: RdmaCounters | null;
  current: RdmaCounters;
  intervalMs: number;
}): SystemRdmaActivity {
  const seconds = input.intervalMs > 0 ? input.intervalMs / 1_000 : 0;
  let received = -1n;
  let transmitted = -1n;
  if (
    input.previous?.device === input.current.device &&
    input.previous.port === input.current.port
  ) {
    received = input.current.receiveDataUnits - input.previous.receiveDataUnits;
    transmitted =
      input.current.transmitDataUnits - input.previous.transmitDataUnits;
  }
  const valid = seconds > 0 && received >= 0n && transmitted >= 0n;

  return {
    device: input.current.device,
    port: input.current.port,
    receiveBytesPerSec: valid
      ? Number(received * COUNTER_UNIT_BYTES) / seconds
      : null,
    transmitBytesPerSec: valid
      ? Number(transmitted * COUNTER_UNIT_BYTES) / seconds
      : null,
    intervalMs: input.intervalMs > 0 ? Math.round(input.intervalMs) : null,
  };
}
