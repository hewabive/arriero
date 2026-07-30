import type {
  SystemDiskActivity,
  SystemDiskDevice,
  SystemIoPressure,
} from "@arriero/core";
import { readFileSync, statSync } from "node:fs";

const SECTOR_BYTES = 512;
const EXCLUDED_PREFIXES = ["loop", "ram", "zram", "dm-", "md", "sr", "fd"];

export type DiskCounters = {
  readIos: number;
  readSectors: number;
  readMs: number;
  writeIos: number;
  writeSectors: number;
  writeMs: number;
  ioTicks: number;
};

type DiskMeta = {
  type: SystemDiskDevice["type"];
  model: string | null;
  sizeBytes: number | null;
};

export function parseDiskStats(contents: string): Map<string, DiskCounters> {
  const result = new Map<string, DiskCounters>();
  for (const line of contents.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) {
      continue;
    }
    const name = fields[2];
    if (!name) {
      continue;
    }
    const counters: DiskCounters = {
      readIos: Number(fields[3]),
      readSectors: Number(fields[5]),
      readMs: Number(fields[6]),
      writeIos: Number(fields[7]),
      writeSectors: Number(fields[9]),
      writeMs: Number(fields[10]),
      ioTicks: Number(fields[12]),
    };
    if (Object.values(counters).some((value) => !Number.isFinite(value))) {
      continue;
    }
    result.set(name, counters);
  }
  return result;
}

export function computeDiskActivity(input: {
  previous: Map<string, DiskCounters>;
  current: Map<string, DiskCounters>;
  intervalMs: number;
  names: string[];
  meta: Map<string, DiskMeta>;
  ioPressure: SystemIoPressure | null;
}): SystemDiskActivity {
  const seconds = input.intervalMs > 0 ? input.intervalMs / 1000 : 0;
  const devices: SystemDiskDevice[] = [];
  let totalRead: number | null = seconds > 0 ? 0 : null;
  let totalWrite: number | null = seconds > 0 ? 0 : null;

  for (const name of input.names) {
    const cur = input.current.get(name);
    if (!cur) {
      continue;
    }
    const prev = input.previous.get(name);
    const meta = input.meta.get(name) ?? {
      type: "unknown" as const,
      model: null,
      sizeBytes: null,
    };

    const dRdSectors = prev ? cur.readSectors - prev.readSectors : -1;
    const dWrSectors = prev ? cur.writeSectors - prev.writeSectors : -1;
    const dTicks = prev ? cur.ioTicks - prev.ioTicks : -1;
    const valid =
      seconds > 0 &&
      prev !== undefined &&
      dRdSectors >= 0 &&
      dWrSectors >= 0 &&
      dTicks >= 0;

    const dRdIos = prev ? cur.readIos - prev.readIos : 0;
    const dWrIos = prev ? cur.writeIos - prev.writeIos : 0;
    const dRdMs = prev ? cur.readMs - prev.readMs : 0;
    const dWrMs = prev ? cur.writeMs - prev.writeMs : 0;

    const readBytesPerSec = valid
      ? (Math.max(0, dRdSectors) * SECTOR_BYTES) / seconds
      : null;
    const writeBytesPerSec = valid
      ? (Math.max(0, dWrSectors) * SECTOR_BYTES) / seconds
      : null;
    const readIops = valid ? Math.max(0, dRdIos) / seconds : null;
    const writeIops = valid ? Math.max(0, dWrIos) / seconds : null;
    const utilPercent = valid
      ? Math.min(100, (Math.max(0, dTicks) / input.intervalMs) * 100)
      : null;
    const avgReadLatencyMs =
      valid && dRdIos > 0 ? Math.max(0, dRdMs) / dRdIos : null;
    const avgWriteLatencyMs =
      valid && dWrIos > 0 ? Math.max(0, dWrMs) / dWrIos : null;

    if (readBytesPerSec !== null && totalRead !== null) {
      totalRead += readBytesPerSec;
    }
    if (writeBytesPerSec !== null && totalWrite !== null) {
      totalWrite += writeBytesPerSec;
    }

    devices.push({
      name,
      model: meta.model,
      type: meta.type,
      readBytesPerSec,
      writeBytesPerSec,
      readIops,
      writeIops,
      utilPercent,
      avgReadLatencyMs,
      avgWriteLatencyMs,
      sizeBytes: meta.sizeBytes,
    });
  }

  return {
    devices,
    totalReadBytesPerSec: totalRead,
    totalWriteBytesPerSec: totalWrite,
    ioPressure: input.ioPressure,
    intervalMs: input.intervalMs > 0 ? Math.round(input.intervalMs) : null,
  };
}

function isReportableDisk(name: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return false;
  }
  try {
    return statSync(`/sys/block/${name}`).isDirectory();
  } catch {
    return false;
  }
}

function readSysString(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readDiskMeta(name: string): DiskMeta {
  const rotational = readSysString(`/sys/block/${name}/queue/rotational`);
  const type =
    rotational === "0" ? "ssd" : rotational === "1" ? "hdd" : "unknown";
  const sizeSectors = Number(readSysString(`/sys/block/${name}/size`));
  return {
    type,
    model: readSysString(`/sys/block/${name}/device/model`),
    sizeBytes: Number.isFinite(sizeSectors) ? sizeSectors * SECTOR_BYTES : null,
  };
}

export function parseIoPressure(contents: string): SystemIoPressure | null {
  const line = contents.split("\n").find((entry) => entry.startsWith("full"));
  if (!line) {
    return null;
  }
  const avg10 = Number(/avg10=([0-9.]+)/.exec(line)?.[1]);
  const avg60 = Number(/avg60=([0-9.]+)/.exec(line)?.[1]);
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) {
    return null;
  }
  return {
    avg10: Math.min(100, Math.max(0, avg10)),
    avg60: Math.min(100, Math.max(0, avg60)),
  };
}

function readIoPressure(): SystemIoPressure | null {
  try {
    return parseIoPressure(readFileSync("/proc/pressure/io", "utf8"));
  } catch {
    return null;
  }
}

let previousSample: { at: number; counters: Map<string, DiskCounters> } | null =
  null;
let latest: SystemDiskActivity | null = null;
const metaCache = new Map<string, DiskMeta>();

function cachedDiskMeta(name: string): DiskMeta {
  const cached = metaCache.get(name);
  if (cached) {
    return cached;
  }
  const meta = readDiskMeta(name);
  metaCache.set(name, meta);
  return meta;
}

export function sampleDiskActivity(): SystemDiskActivity | null {
  if (process.platform !== "linux") {
    return null;
  }
  let contents: string;
  try {
    contents = readFileSync("/proc/diskstats", "utf8");
  } catch {
    return null;
  }

  const now = Date.now();
  const all = parseDiskStats(contents);
  const names = [...all.keys()].filter(isReportableDisk).sort();
  const counters = new Map(names.map((name) => [name, all.get(name)!]));

  latest = computeDiskActivity({
    previous: previousSample?.counters ?? counters,
    current: counters,
    intervalMs: previousSample ? now - previousSample.at : 0,
    names,
    meta: new Map(names.map((name) => [name, cachedDiskMeta(name)])),
    ioPressure: readIoPressure(),
  });
  previousSample = { at: now, counters };
  return latest;
}

export function readDiskActivity(): SystemDiskActivity | null {
  return latest ?? sampleDiskActivity();
}
