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
import { clampRatio } from "./clamp.js";
import { readSystemMemory } from "./memory.js";
import { systemMetricsRecorder } from "./metrics-history.js";
import { getStorageResources } from "./storage-space.js";
import { uvToolStatus } from "../envs/uv.js";

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
    computeCapability: device.computeCapability,
    source: "nvml",
    ...(device.ecc ? { ecc: device.ecc } : {}),
    ...(device.recoveryAction ? { recoveryAction: device.recoveryAction } : {}),
  }));
}

export function getSystemAccelerators(): SystemAccelerator[] {
  return nvidiaDevicesToAccelerators(nvidiaTelemetry.accelerators());
}

export type GpuInventory = {
  authoritative: boolean;
  deviceRefs: Set<string>;
};

export function getKnownGpuInventory(): GpuInventory {
  const state = nvidiaTelemetry.status().state;
  return {
    authoritative: state === "ready" || state === "no-devices",
    deviceRefs: new Set(
      nvidiaTelemetry.accelerators().map((device) => String(device.index)),
    ),
  };
}

export function getSystemResources(): SystemResources {
  const sampled = systemMetricsRecorder.current();
  return {
    checkedAt: new Date().toISOString(),
    memory: readSystemMemory(),
    accelerators: getSystemAccelerators(),
    disk: sampled.disk,
    storage: null,
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

export function getSystemResourcesWithStorage(): SystemResources {
  const resources = getSystemResources();
  resources.storage = getStorageResources(systemMetricsRecorder.current().rdma);
  return resources;
}
