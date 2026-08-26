import { z } from "zod";

import {
  NodeSourceToolStatusSchema,
  UvToolStatusSchema,
} from "./environments.js";

export const NetworkInterfaceAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
  family: z.enum(["IPv4", "IPv6"]),
  internal: z.boolean(),
  cidr: z.string().nullable(),
  mac: z.string().nullable(),
});

export const NetworkInterfacesResultSchema = z.object({
  interfaces: z.array(NetworkInterfaceAddressSchema),
});

export const SystemMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  usedRatio: z.number().min(0).max(1),
  source: z.enum(["proc-meminfo", "node-os"]),
});

export const ComputeCapabilitySchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});

export const SystemAcceleratorRemappedRowsSchema = z.object({
  corrected: z.number().int().nonnegative(),
  uncorrected: z.number().int().nonnegative(),
  pending: z.boolean(),
  failure: z.boolean(),
});

export const SystemAcceleratorRetiredPagesSchema = z.object({
  corrected: z.number().int().nonnegative().optional(),
  uncorrected: z.number().int().nonnegative().optional(),
  pending: z.boolean().nullable(),
});

export const SystemAcceleratorEccSchema = z.object({
  corrected: z.number().int().nonnegative().optional(),
  uncorrected: z.number().int().nonnegative().optional(),
  remappedRows: SystemAcceleratorRemappedRowsSchema.optional(),
  retiredPages: SystemAcceleratorRetiredPagesSchema.optional(),
});

export const SystemAcceleratorThrottleReasonSchema = z.enum([
  "hw-slowdown",
  "hw-thermal",
  "hw-power-brake",
  "sw-thermal",
  "sw-power-cap",
]);

export const SystemAcceleratorPcieSchema = z.object({
  currentGeneration: z.number().int().nonnegative().optional(),
  currentWidth: z.number().int().nonnegative().optional(),
  maxGeneration: z.number().int().nonnegative().optional(),
  maxWidth: z.number().int().nonnegative().optional(),
  replayCounter: z.number().int().nonnegative().optional(),
});

export const SystemAcceleratorRecoveryActionSchema = z.enum([
  "none",
  "gpu-reset",
  "node-reboot",
  "drain-p2p",
  "drain-and-reset",
  "recover-imex-domain",
]);

export const SystemAcceleratorSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string().nullable(),
  kind: z.enum(["gpu", "accelerator"]),
  totalMemoryBytes: z.number().int().nonnegative().nullable(),
  availableMemoryBytes: z.number().int().nonnegative().nullable(),
  memoryUsedRatio: z.number().min(0).max(1).nullable(),
  utilizationPercent: z.number().min(0).max(100).nullable(),
  temperatureC: z.number().nullable(),
  numaNode: z.number().int().min(0).nullable(),
  computeCapability: ComputeCapabilitySchema.nullable().default(null),
  source: z.string(),
  memoryTemperatureC: z.number().optional(),
  ecc: SystemAcceleratorEccSchema.optional(),
  recoveryAction: SystemAcceleratorRecoveryActionSchema.optional(),
  throttleReasons: z.array(SystemAcceleratorThrottleReasonSchema).optional(),
  pcie: SystemAcceleratorPcieSchema.optional(),
});

export function formatComputeCapability(value: ComputeCapability): string {
  return `${value.major}.${value.minor}`;
}

export function meetsComputeCapability(
  value: ComputeCapability,
  minimum: ComputeCapability,
): boolean {
  return (
    value.major > minimum.major ||
    (value.major === minimum.major && value.minor >= minimum.minor)
  );
}

export function cudaComputeCapabilityShortfall(
  accelerators: SystemAccelerator[],
  minimum: ComputeCapability,
  engineLabel: string,
): string | null {
  const nvidia = accelerators.filter(
    (accelerator) =>
      accelerator.kind === "gpu" && accelerator.vendor === "NVIDIA",
  );
  if (nvidia.length === 0) {
    return null;
  }
  const known = nvidia.flatMap((accelerator) =>
    accelerator.computeCapability
      ? [{ name: accelerator.name, capability: accelerator.computeCapability }]
      : [],
  );
  if (known.length < nvidia.length) {
    return null;
  }
  if (
    known.some((entry) => meetsComputeCapability(entry.capability, minimum))
  ) {
    return null;
  }
  const report = known
    .map(
      (entry) =>
        `${entry.name} reports ${formatComputeCapability(entry.capability)}`,
    )
    .join(", ");
  return `${engineLabel} requires CUDA compute capability ${formatComputeCapability(minimum)} or newer; ${report}`;
}

export const NumaNodeSchema = z.object({
  id: z.number().int().min(0),
  cpus: z.string(),
  cpuCount: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  memFreeBytes: z.number().int().nonnegative().default(0),
  filePagesBytes: z.number().int().nonnegative().default(0),
  online: z.boolean(),
});

export const NumaCapabilitiesSchema = z.object({
  nodes: z.array(NumaNodeSchema),
  bind: z.boolean(),
  interleave: z.boolean(),
});

export const SystemDiskDeviceSchema = z.object({
  name: z.string(),
  model: z.string().nullable(),
  type: z.enum(["ssd", "hdd", "unknown"]),
  readBytesPerSec: z.number().nonnegative().nullable(),
  writeBytesPerSec: z.number().nonnegative().nullable(),
  readIops: z.number().nonnegative().nullable(),
  writeIops: z.number().nonnegative().nullable(),
  utilPercent: z.number().min(0).max(100).nullable(),
  avgReadLatencyMs: z.number().nonnegative().nullable(),
  avgWriteLatencyMs: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const SystemIoPressureSchema = z.object({
  avg10: z.number().min(0).max(100),
  avg60: z.number().min(0).max(100),
});

export const SystemDiskActivitySchema = z.object({
  devices: z.array(SystemDiskDeviceSchema),
  totalReadBytesPerSec: z.number().nonnegative().nullable(),
  totalWriteBytesPerSec: z.number().nonnegative().nullable(),
  ioPressure: SystemIoPressureSchema.nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemRdmaActivitySchema = z.object({
  device: z.string(),
  port: z.number().int().positive(),
  receiveBytesPerSec: z.number().nonnegative().nullable(),
  transmitBytesPerSec: z.number().nonnegative().nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemStorageSpaceSchema = z.object({
  mountPath: z.string(),
  source: z.string(),
  fsType: z.string(),
  kind: z.enum(["local", "beegfs"]),
  cfgFile: z.string().nullable(),
  totalBytes: z.number().nonnegative().nullable(),
  freeBytes: z.number().nonnegative().nullable(),
  totalInodes: z.number().nonnegative().nullable(),
  freeInodes: z.number().nonnegative().nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const SystemStorageResourcesSchema = z.object({
  checkedAt: z.string(),
  filesystems: z.array(SystemStorageSpaceSchema),
  rdma: SystemRdmaActivitySchema.nullable().default(null),
});

export const SystemCpuCoreSchema = z.object({
  id: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
});

export const SystemCpuActivitySchema = z.object({
  usagePercent: z.number().min(0).max(100),
  userPercent: z.number().min(0).max(100),
  systemPercent: z.number().min(0).max(100),
  ioWaitPercent: z.number().min(0).max(100),
  stealPercent: z.number().min(0).max(100),
  cores: z.array(SystemCpuCoreSchema),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemNetworkInterfaceSchema = z.object({
  name: z.string(),
  rxBytesPerSec: z.number().nonnegative().nullable(),
  txBytesPerSec: z.number().nonnegative().nullable(),
  rxPacketsPerSec: z.number().nonnegative().nullable(),
  txPacketsPerSec: z.number().nonnegative().nullable(),
  speedMbps: z.number().nonnegative().nullable(),
  up: z.boolean(),
});

export const SystemNetworkActivitySchema = z.object({
  interfaces: z.array(SystemNetworkInterfaceSchema),
  totalRxBytesPerSec: z.number().nonnegative().nullable(),
  totalTxBytesPerSec: z.number().nonnegative().nullable(),
  intervalMs: z.number().nonnegative().nullable(),
});

export const SystemResourcesSchema = z.object({
  checkedAt: z.string(),
  memory: SystemMemorySchema,
  accelerators: z.array(SystemAcceleratorSchema),
  disk: SystemDiskActivitySchema.nullable(),
  storage: SystemStorageResourcesSchema.nullable().default(null),
  cpu: SystemCpuActivitySchema.nullable().default(null),
  network: SystemNetworkActivitySchema.nullable().default(null),
  numa: NumaCapabilitiesSchema,
  tools: z
    .object({
      uv: UvToolStatusSchema,
      nodeSource: NodeSourceToolStatusSchema.optional(),
    })
    .optional(),
});

export const SystemMetricsGpuSampleSchema = z.object({
  id: z.string(),
  utilizationPercent: z.number().nullable(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  temperatureC: z.number().nullable(),
});

export const SystemMetricsDiskSampleSchema = SystemDiskDeviceSchema.pick({
  name: true,
  utilPercent: true,
  readBytesPerSec: true,
  writeBytesPerSec: true,
});

export const SystemMetricsNetworkSampleSchema =
  SystemNetworkInterfaceSchema.pick({
    name: true,
    rxBytesPerSec: true,
    txBytesPerSec: true,
  });

export const SystemMetricsRdmaSampleSchema = SystemRdmaActivitySchema.pick({
  device: true,
  port: true,
  receiveBytesPerSec: true,
  transmitBytesPerSec: true,
});

export const SystemMetricsSampleSchema = z.object({
  at: z.number().int().nonnegative(),
  cpuPercent: z.number().nullable(),
  memoryUsedBytes: z.number().nonnegative(),
  memoryTotalBytes: z.number().nonnegative(),
  gpus: z.array(SystemMetricsGpuSampleSchema),
  disks: z.array(SystemMetricsDiskSampleSchema),
  network: z.array(SystemMetricsNetworkSampleSchema),
  rdma: SystemMetricsRdmaSampleSchema.nullable().default(null),
  eventLoopMaxLagMs: z.number().nonnegative().nullable().default(null),
});

export const EventLoopBlockingSectionSchema = z.object({
  label: z.string(),
  durationMs: z.number().nonnegative(),
  endedAt: z.number().int().nonnegative(),
});

export const EventLoopStallSignalsSchema = z.object({
  cpuMs: z.number().nonnegative(),
  runDelayMs: z.number().nonnegative(),
  eluActiveMs: z.number().nonnegative(),
  majorPageFaults: z.number().int().nonnegative(),
});

export const EventLoopStallVerdictSchema = z.enum([
  "self-cpu",
  "self-wait",
  "starved",
  "paging",
  "unknown",
]);

export const EventLoopStallSchema = z.object({
  detectedAt: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  verdict: EventLoopStallVerdictSchema,
  signals: EventLoopStallSignalsSchema.nullable(),
  culprits: z.array(EventLoopBlockingSectionSchema),
});

export const EventLoopReportSchema = z.object({
  stallThresholdMs: z.number().positive(),
  sectionThresholdMs: z.number().positive(),
  stalls: z.array(EventLoopStallSchema),
  slowSections: z.array(EventLoopBlockingSectionSchema),
});

export const SYSTEM_METRICS_WINDOWS = ["live", "hour", "day", "month"] as const;

export const SystemMetricsWindowSchema = z.enum(SYSTEM_METRICS_WINDOWS);

export const SystemMetricsCoarseWindowSchema =
  SystemMetricsWindowSchema.exclude(["live"]);

export const SystemMetricsHistorySchema = z.object({
  window: SystemMetricsWindowSchema,
  intervalMs: z.number().int().positive(),
  capacity: z.number().int().positive(),
  samples: z.array(SystemMetricsSampleSchema),
});

export const SYSTEM_METRICS_TIERS: Record<
  z.infer<typeof SystemMetricsWindowSchema>,
  { intervalMs: number; capacity: number }
> = {
  live: { intervalMs: 1_000, capacity: 300 },
  hour: { intervalMs: 10_000, capacity: 360 },
  day: { intervalMs: 60_000, capacity: 1_440 },
  month: { intervalMs: 1_800_000, capacity: 1_440 },
};

export type NetworkInterfaceAddress = z.infer<
  typeof NetworkInterfaceAddressSchema
>;
export type NetworkInterfacesResult = z.infer<
  typeof NetworkInterfacesResultSchema
>;
export type SystemMemory = z.infer<typeof SystemMemorySchema>;
export type ComputeCapability = z.infer<typeof ComputeCapabilitySchema>;
export type SystemAcceleratorRemappedRows = z.infer<
  typeof SystemAcceleratorRemappedRowsSchema
>;
export type SystemAcceleratorRetiredPages = z.infer<
  typeof SystemAcceleratorRetiredPagesSchema
>;
export type SystemAcceleratorEcc = z.infer<typeof SystemAcceleratorEccSchema>;
export type SystemAcceleratorThrottleReason = z.infer<
  typeof SystemAcceleratorThrottleReasonSchema
>;
export type SystemAcceleratorPcie = z.infer<typeof SystemAcceleratorPcieSchema>;
export type SystemAcceleratorRecoveryAction = z.infer<
  typeof SystemAcceleratorRecoveryActionSchema
>;
export type SystemAccelerator = z.infer<typeof SystemAcceleratorSchema>;
export type SystemDiskDevice = z.infer<typeof SystemDiskDeviceSchema>;
export type SystemIoPressure = z.infer<typeof SystemIoPressureSchema>;
export type SystemDiskActivity = z.infer<typeof SystemDiskActivitySchema>;
export type SystemRdmaActivity = z.infer<typeof SystemRdmaActivitySchema>;
export type SystemStorageSpace = z.infer<typeof SystemStorageSpaceSchema>;
export type SystemStorageResources = z.infer<
  typeof SystemStorageResourcesSchema
>;
export type SystemCpuCore = z.infer<typeof SystemCpuCoreSchema>;
export type SystemCpuActivity = z.infer<typeof SystemCpuActivitySchema>;
export type SystemNetworkInterface = z.infer<
  typeof SystemNetworkInterfaceSchema
>;
export type SystemNetworkActivity = z.infer<typeof SystemNetworkActivitySchema>;
export type SystemMetricsGpuSample = z.infer<
  typeof SystemMetricsGpuSampleSchema
>;
export type SystemMetricsDiskSample = z.infer<
  typeof SystemMetricsDiskSampleSchema
>;
export type SystemMetricsNetworkSample = z.infer<
  typeof SystemMetricsNetworkSampleSchema
>;
export type SystemMetricsRdmaSample = z.infer<
  typeof SystemMetricsRdmaSampleSchema
>;
export type SystemMetricsSample = z.infer<typeof SystemMetricsSampleSchema>;
export type EventLoopBlockingSection = z.infer<
  typeof EventLoopBlockingSectionSchema
>;
export type EventLoopStallSignals = z.infer<typeof EventLoopStallSignalsSchema>;
export type EventLoopStallVerdict = z.infer<typeof EventLoopStallVerdictSchema>;
export type EventLoopStall = z.infer<typeof EventLoopStallSchema>;
export type EventLoopReport = z.infer<typeof EventLoopReportSchema>;
export type SystemMetricsWindow = z.infer<typeof SystemMetricsWindowSchema>;
export type SystemMetricsCoarseWindow = z.infer<
  typeof SystemMetricsCoarseWindowSchema
>;
export type SystemMetricsHistory = z.infer<typeof SystemMetricsHistorySchema>;
export type NumaNode = z.infer<typeof NumaNodeSchema>;
export type NumaCapabilities = z.infer<typeof NumaCapabilitiesSchema>;
export type SystemResources = z.infer<typeof SystemResourcesSchema>;
