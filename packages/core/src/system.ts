import { z } from "zod";

import { UvToolStatusSchema } from "./environments.js";

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
  source: z.string(),
});

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
  tools: z.object({ uv: UvToolStatusSchema }).optional(),
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

export const EventLoopStallSchema = z.object({
  detectedAt: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  culprits: z.array(EventLoopBlockingSectionSchema),
});

export const EventLoopReportSchema = z.object({
  stallThresholdMs: z.number().positive(),
  sectionThresholdMs: z.number().positive(),
  stalls: z.array(EventLoopStallSchema),
  slowSections: z.array(EventLoopBlockingSectionSchema),
});

export const SystemMetricsWindowSchema = z.enum([
  "live",
  "hour",
  "day",
  "month",
]);

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
