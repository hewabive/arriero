import type {
  SystemNetworkActivity,
  SystemNetworkInterface,
} from "@arriero/core";
import { readFileSync } from "node:fs";

const EXCLUDED_PREFIXES = ["lo", "veth", "docker", "br-", "virbr", "dummy"];
const META_CACHE_MS = 30_000;

export type NetCounters = {
  rxBytes: number;
  rxPackets: number;
  txBytes: number;
  txPackets: number;
};

export type NetInterfaceMeta = {
  speedMbps: number | null;
  up: boolean;
};

export function isReportableInterface(name: string): boolean {
  return !EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function parseProcNetDev(contents: string): Map<string, NetCounters> {
  const result = new Map<string, NetCounters>();
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 16 || fields.some((value) => !Number.isFinite(value))) {
      continue;
    }
    result.set(name, {
      rxBytes: fields[0]!,
      rxPackets: fields[1]!,
      txBytes: fields[8]!,
      txPackets: fields[9]!,
    });
  }
  return result;
}

export function computeNetworkActivity(input: {
  previous: Map<string, NetCounters> | null;
  current: Map<string, NetCounters>;
  intervalMs: number;
  names: string[];
  meta: Map<string, NetInterfaceMeta>;
}): SystemNetworkActivity {
  const seconds = input.intervalMs > 0 ? input.intervalMs / 1000 : 0;
  const interfaces: SystemNetworkInterface[] = [];
  let totalRx: number | null = seconds > 0 ? 0 : null;
  let totalTx: number | null = seconds > 0 ? 0 : null;

  for (const name of input.names) {
    const current = input.current.get(name);
    if (!current) {
      continue;
    }
    const previous = input.previous?.get(name);
    const meta = input.meta.get(name) ?? { speedMbps: null, up: false };

    const rxBytes = previous ? current.rxBytes - previous.rxBytes : -1;
    const txBytes = previous ? current.txBytes - previous.txBytes : -1;
    const valid = seconds > 0 && rxBytes >= 0 && txBytes >= 0;

    const rxBytesPerSec = valid ? rxBytes / seconds : null;
    const txBytesPerSec = valid ? txBytes / seconds : null;
    if (rxBytesPerSec !== null && totalRx !== null) {
      totalRx += rxBytesPerSec;
    }
    if (txBytesPerSec !== null && totalTx !== null) {
      totalTx += txBytesPerSec;
    }

    interfaces.push({
      name,
      rxBytesPerSec,
      txBytesPerSec,
      rxPacketsPerSec:
        valid && previous
          ? Math.max(0, current.rxPackets - previous.rxPackets) / seconds
          : null,
      txPacketsPerSec:
        valid && previous
          ? Math.max(0, current.txPackets - previous.txPackets) / seconds
          : null,
      speedMbps: meta.speedMbps,
      up: meta.up,
    });
  }

  return {
    interfaces,
    totalRxBytesPerSec: totalRx,
    totalTxBytesPerSec: totalTx,
    intervalMs: input.intervalMs > 0 ? Math.round(input.intervalMs) : null,
  };
}

function readSysString(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readInterfaceMeta(name: string): NetInterfaceMeta {
  const speed = Number(readSysString(`/sys/class/net/${name}/speed`));
  return {
    speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
    up: readSysString(`/sys/class/net/${name}/operstate`) === "up",
  };
}

let metaCache: {
  expiresAt: number;
  value: Map<string, NetInterfaceMeta>;
} | null = null;

function cachedMeta(
  names: string[],
  now: number,
): Map<string, NetInterfaceMeta> {
  if (metaCache && metaCache.expiresAt > now) {
    return metaCache.value;
  }
  const value = new Map(names.map((name) => [name, readInterfaceMeta(name)]));
  metaCache = { expiresAt: now + META_CACHE_MS, value };
  return value;
}

export function readNetCounters(): Map<string, NetCounters> | null {
  try {
    return parseProcNetDev(readFileSync("/proc/net/dev", "utf8"));
  } catch {
    return null;
  }
}

export function buildNetworkActivity(input: {
  previous: Map<string, NetCounters> | null;
  current: Map<string, NetCounters>;
  intervalMs: number;
  now: number;
}): SystemNetworkActivity {
  const names = [...input.current.keys()].filter(isReportableInterface).sort();
  return computeNetworkActivity({
    previous: input.previous,
    current: input.current,
    intervalMs: input.intervalMs,
    names,
    meta: cachedMeta(names, input.now),
  });
}
