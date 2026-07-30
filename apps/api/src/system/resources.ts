import type {
  SystemAccelerator,
  SystemMemory,
  SystemResources,
} from "@arriero/core";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import {
  detectNumaBind,
  detectNumaInterleave,
  readNumaTopology,
  readPciNumaNode,
} from "../numa/index.js";
import {
  type NvidiaDeviceSnapshot,
  nvidiaTelemetry,
} from "../nvidia/telemetry.js";
import { readDiskActivity } from "./disk.js";
import { uvToolStatus } from "../envs/uv.js";

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function toMemory(input: {
  totalBytes: number;
  availableBytes: number;
  source: SystemMemory["source"];
}): SystemMemory {
  const totalBytes = Math.max(0, Math.floor(input.totalBytes));
  const availableBytes = Math.min(
    totalBytes,
    Math.max(0, Math.floor(input.availableBytes)),
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedRatio: totalBytes === 0 ? 0 : clampRatio(usedBytes / totalBytes),
    source: input.source,
  };
}

export function parseLinuxMeminfo(contents: string): SystemMemory | null {
  const values = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) {
      values.set(match[1]!, Number(match[2]) * 1024);
    }
  }

  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (totalBytes === undefined || availableBytes === undefined) {
    return null;
  }

  return toMemory({
    totalBytes,
    availableBytes,
    source: "proc-meminfo",
  });
}

function readLinuxMemory(): SystemMemory | null {
  try {
    return parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

function readNodeMemory(): SystemMemory {
  return toMemory({
    totalBytes: totalmem(),
    availableBytes: freemem(),
    source: "node-os",
  });
}

export function nvidiaDevicesToAccelerators(
  devices: NvidiaDeviceSnapshot[],
  resolveNumaNode: (busId: string) => number | null = readPciNumaNode,
): SystemAccelerator[] {
  return devices.map((device) => ({
    id: String(device.index),
    name: device.name,
    vendor: "NVIDIA",
    kind: "gpu",
    totalMemoryBytes: device.totalMemoryBytes,
    availableMemoryBytes: device.freeMemoryBytes,
    memoryUsedRatio:
      device.totalMemoryBytes === 0
        ? null
        : clampRatio(device.usedMemoryBytes / device.totalMemoryBytes),
    utilizationPercent: device.utilizationPercent,
    temperatureC: device.temperatureC,
    numaNode: device.pciBusId ? resolveNumaNode(device.pciBusId) : null,
    source: "nvml",
  }));
}

export function getSystemAccelerators(): SystemAccelerator[] {
  return nvidiaDevicesToAccelerators(nvidiaTelemetry.accelerators());
}

export function getSystemResources(): SystemResources {
  return {
    checkedAt: new Date().toISOString(),
    memory: readLinuxMemory() ?? readNodeMemory(),
    accelerators: getSystemAccelerators(),
    disk: readDiskActivity(),
    numa: {
      nodes: readNumaTopology(),
      bind: detectNumaBind(),
      interleave: detectNumaInterleave(),
    },
    tools: { uv: uvToolStatus() },
  };
}
