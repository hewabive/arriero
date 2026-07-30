import type { SystemAccelerator, SystemResources } from "@arriero/core";
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
import { readSystemMemory } from "./memory.js";
import { systemMetricsRecorder } from "./metrics-history.js";
import { uvToolStatus } from "../envs/uv.js";

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
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
  const sampled = systemMetricsRecorder.current();
  return {
    checkedAt: new Date().toISOString(),
    memory: readSystemMemory(),
    accelerators: getSystemAccelerators(),
    disk: sampled.disk,
    cpu: sampled.cpu,
    network: sampled.network,
    numa: {
      nodes: readNumaTopology(),
      bind: detectNumaBind(),
      interleave: detectNumaInterleave(),
    },
    tools: { uv: uvToolStatus() },
  };
}
