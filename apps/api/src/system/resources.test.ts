import { strict as assert } from "node:assert";
import test from "node:test";

import { parseLinuxMeminfo } from "./memory.js";
import { nvidiaDevicesToAccelerators } from "./resources.js";

test("parseLinuxMeminfo uses MemAvailable as available RAM", () => {
  const memory = parseLinuxMeminfo(`
MemTotal:       16384 kB
MemFree:         1024 kB
MemAvailable:    4096 kB
Buffers:          256 kB
Cached:          2048 kB
`);

  assert.deepEqual(memory, {
    totalBytes: 16 * 1024 * 1024,
    availableBytes: 4 * 1024 * 1024,
    usedBytes: 12 * 1024 * 1024,
    usedRatio: 0.75,
    source: "proc-meminfo",
  });
});

test("parseLinuxMeminfo returns null when required fields are missing", () => {
  assert.equal(parseLinuxMeminfo("MemTotal: 16384 kB\n"), null);
});

test("nvidiaDevicesToAccelerators maps NVML device telemetry", () => {
  const accelerators = nvidiaDevicesToAccelerators([
    {
      index: 0,
      name: "NVIDIA RTX 4090",
      uuid: "GPU-0",
      pciBusId: "",
      computeCapability: { major: 8, minor: 9 },
      totalMemoryBytes: 24_564 * 1024 * 1024,
      freeMemoryBytes: (24_564 - 1_024) * 1024 * 1024,
      usedMemoryBytes: 1_024 * 1024 * 1024,
      utilizationPercent: 12,
      temperatureC: 55,
      ecc: {
        corrected: 2,
        uncorrected: 1,
        remappedRows: {
          corrected: 1,
          uncorrected: 0,
          pending: true,
          failure: false,
        },
      },
      recoveryAction: "gpu-reset",
    },
  ]);

  assert.equal(accelerators.length, 1);
  assert.deepEqual(accelerators[0], {
    id: "0",
    name: "NVIDIA RTX 4090",
    vendor: "NVIDIA",
    kind: "gpu",
    totalMemoryBytes: 24564 * 1024 * 1024,
    availableMemoryBytes: (24564 - 1024) * 1024 * 1024,
    memoryUsedRatio: 1024 / 24564,
    utilizationPercent: 12,
    temperatureC: 55,
    numaNode: null,
    computeCapability: { major: 8, minor: 9 },
    source: "nvml",
    ecc: {
      corrected: 2,
      uncorrected: 1,
      remappedRows: {
        corrected: 1,
        uncorrected: 0,
        pending: true,
        failure: false,
      },
    },
    recoveryAction: "gpu-reset",
  });
});

test("nvidiaDevicesToAccelerators maps pci bus ids to NUMA nodes", () => {
  const accelerators = nvidiaDevicesToAccelerators(
    [
      {
        index: 0,
        name: "NVIDIA RTX 4090",
        uuid: "GPU-0",
        pciBusId: "00000000:01:00.0",
        computeCapability: { major: 8, minor: 9 },
        totalMemoryBytes: 24,
        freeMemoryBytes: 20,
        usedMemoryBytes: 4,
        utilizationPercent: 12,
        temperatureC: 55,
        ecc: null,
        recoveryAction: null,
      },
      {
        index: 1,
        name: "NVIDIA RTX A6000",
        uuid: "GPU-1",
        pciBusId: "00000000:81:00.0",
        computeCapability: { major: 8, minor: 6 },
        totalMemoryBytes: 48,
        freeMemoryBytes: 40,
        usedMemoryBytes: 8,
        utilizationPercent: 0,
        temperatureC: 42,
        ecc: null,
        recoveryAction: null,
      },
    ],
    (busId) => (busId === "00000000:81:00.0" ? 1 : 0),
  );

  assert.equal(accelerators[0]?.numaNode, 0);
  assert.equal(accelerators[1]?.numaNode, 1);
});
