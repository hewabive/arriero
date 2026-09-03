import type { SystemMetricsSample } from "@arriero/core";

export function metricsSampleFixture(
  input: Partial<SystemMetricsSample>,
): SystemMetricsSample {
  return {
    at: 0,
    cpuPercent: 0,
    cpuStealPercent: null,
    memoryUsedBytes: 0,
    memoryTotalBytes: 1_000,
    gpus: [],
    disks: [],
    network: [],
    rdma: null,
    eventLoopMaxLagMs: null,
    ...input,
  };
}
