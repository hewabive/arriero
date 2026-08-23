import assert from "node:assert/strict";
import test from "node:test";

import {
  type NvmlBinding,
  type NvmlComputeCapability,
  type NvmlDeviceHandle,
  type NvmlEccErrors,
  type NvmlGpuRecoveryAction,
  type NvmlMemoryInfo,
  type NvmlProcessInfo,
  type NvmlRemappedRows,
  NvmlError,
  NVML_ERROR_DRIVER_NOT_LOADED,
  NVML_ERROR_GPU_IS_LOST,
  NVML_ERROR_NOT_SUPPORTED,
  NvmlLibraryError,
} from "./nvml-binding.js";
import { NvidiaTelemetry } from "./telemetry.js";

type FakeDevice = {
  handle: NvmlDeviceHandle;
  memory: NvmlMemoryInfo;
  name: string;
  pciBusId: string;
  computeCapability: NvmlComputeCapability | null;
  processes: NvmlProcessInfo[];
  eccErrors: NvmlEccErrors | null;
  remappedRows: NvmlRemappedRows | null;
  recoveryAction: NvmlGpuRecoveryAction | null;
  temperatureC: number | null;
  utilizationPercent: number | null;
  uuid: string;
};

class FakeNvmlBinding implements NvmlBinding {
  readonly devices: FakeDevice[];
  initError: Error | null = null;
  memoryError: Error | null = null;
  processError: Error | null = null;
  initializeCalls = 0;
  shutdownCalls = 0;
  memoryCalls = 0;
  processCalls = 0;

  constructor(devices: FakeDevice[]) {
    this.devices = devices;
  }

  initialize(): void {
    this.initializeCalls += 1;
    if (this.initError) throw this.initError;
  }

  shutdown(): void {
    this.shutdownCalls += 1;
  }

  driverVersion(): string {
    return "595.71.05";
  }

  deviceCount(): number {
    return this.devices.length;
  }

  deviceHandle(index: number): NvmlDeviceHandle {
    return this.devices[index]!.handle;
  }

  private device(handle: NvmlDeviceHandle): FakeDevice {
    return this.devices.find((device) => device.handle === handle)!;
  }

  deviceName(handle: NvmlDeviceHandle): string {
    return this.device(handle).name;
  }

  deviceUuid(handle: NvmlDeviceHandle): string {
    return this.device(handle).uuid;
  }

  devicePciBusId(handle: NvmlDeviceHandle): string {
    return this.device(handle).pciBusId;
  }

  deviceCudaComputeCapability(
    handle: NvmlDeviceHandle,
  ): NvmlComputeCapability | null {
    return this.device(handle).computeCapability;
  }

  deviceMemory(handle: NvmlDeviceHandle): NvmlMemoryInfo {
    this.memoryCalls += 1;
    if (this.memoryError) throw this.memoryError;
    return this.device(handle).memory;
  }

  deviceUtilization(handle: NvmlDeviceHandle): number | null {
    return this.device(handle).utilizationPercent;
  }

  deviceTemperature(handle: NvmlDeviceHandle): number | null {
    return this.device(handle).temperatureC;
  }

  deviceEccErrors(handle: NvmlDeviceHandle): NvmlEccErrors | null {
    return this.device(handle).eccErrors;
  }

  deviceRemappedRows(handle: NvmlDeviceHandle): NvmlRemappedRows | null {
    return this.device(handle).remappedRows;
  }

  deviceRecoveryAction(handle: NvmlDeviceHandle): NvmlGpuRecoveryAction | null {
    return this.device(handle).recoveryAction;
  }

  computeProcesses(handle: NvmlDeviceHandle): NvmlProcessInfo[] {
    this.processCalls += 1;
    if (this.processError) throw this.processError;
    return this.device(handle).processes;
  }
}

function fakeDevice(
  index: number,
  overrides: Partial<FakeDevice> = {},
): FakeDevice {
  return {
    handle: BigInt(index + 1),
    memory: {
      totalBytes: 24 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3,
      usedBytes: 4 * 1024 ** 3,
    },
    name: `NVIDIA GPU ${index}`,
    pciBusId: `00000000:0${index + 1}:00.0`,
    computeCapability: { major: 8, minor: 9 },
    processes: [],
    eccErrors: null,
    remappedRows: null,
    recoveryAction: null,
    temperatureC: 42,
    utilizationPercent: 12,
    uuid: `GPU-${index}`,
    ...overrides,
  };
}

test("initializes NVML once and caches accelerator samples", () => {
  let now = 100;
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  const telemetry = new NvidiaTelemetry({
    bindingFactory: () => binding,
    now: () => now,
    acceleratorCacheMs: 10,
  });

  assert.deepEqual(telemetry.status(), {
    state: "ready",
    detail: "1 NVIDIA GPU available through NVML",
    driverVersion: "595.71.05",
    deviceCount: 1,
  });
  assert.deepEqual(telemetry.accelerators(), [
    {
      index: 0,
      name: "NVIDIA GPU 0",
      uuid: "GPU-0",
      pciBusId: "00000000:01:00.0",
      computeCapability: { major: 8, minor: 9 },
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 20 * 1024 ** 3,
      usedMemoryBytes: 4 * 1024 ** 3,
      utilizationPercent: 12,
      temperatureC: 42,
      ecc: null,
      recoveryAction: null,
    },
  ]);
  assert.equal(binding.initializeCalls, 1);
  assert.equal(binding.memoryCalls, 1);

  now += 9;
  telemetry.accelerators();
  assert.equal(binding.memoryCalls, 1);

  now += 1;
  telemetry.accelerators();
  assert.equal(binding.memoryCalls, 2);
  assert.equal(binding.initializeCalls, 1);
});

test("exposes aggregate ECC counters and remapped rows in accelerator snapshots", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, {
      eccErrors: { corrected: 7, uncorrected: 2 },
      remappedRows: {
        corrected: 1,
        uncorrected: 1,
        pending: true,
        failure: false,
      },
    }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.accelerators()[0]?.ecc, {
    corrected: 7,
    uncorrected: 2,
    remappedRows: {
      corrected: 1,
      uncorrected: 1,
      pending: true,
      failure: false,
    },
  });
});

test("omits remapped rows when the remap API is unsupported", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, {
      eccErrors: { corrected: 3, uncorrected: 0 },
    }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.accelerators()[0]?.ecc, {
    corrected: 3,
    uncorrected: 0,
  });
});

test("keeps a partial ECC counter when only one aggregate counter is supported", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, { eccErrors: { uncorrected: 4 } }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.accelerators()[0]?.ecc, { uncorrected: 4 });
});

test("exposes the NVML recovery action in accelerator snapshots", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, { recoveryAction: "gpu-reset" }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.equal(telemetry.accelerators()[0]?.recoveryAction, "gpu-reset");
});

test("keeps remapped rows when ECC counters are unsupported", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, {
      remappedRows: {
        corrected: 1,
        uncorrected: 0,
        pending: true,
        failure: false,
      },
    }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.accelerators()[0]?.ecc, {
    remappedRows: {
      corrected: 1,
      uncorrected: 0,
      pending: true,
      failure: false,
    },
  });
});

test("leaves ecc null when both ECC counters and remap reporting are unsupported", () => {
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.equal(telemetry.accelerators()[0]?.ecc, null);
});

test("collects per-device process memory sorted by pid then device", () => {
  const binding = new FakeNvmlBinding([
    fakeDevice(0, {
      processes: [{ pid: 123, usedMemoryBytes: 100 }],
    }),
    fakeDevice(1, {
      processes: [
        { pid: 456, usedMemoryBytes: 300 },
        { pid: 123, usedMemoryBytes: 200 },
      ],
    }),
  ]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.computeProcesses(), [
    {
      pid: 123,
      usedMemoryBytes: 100,
      deviceIndex: 0,
    },
    {
      pid: 123,
      usedMemoryBytes: 200,
      deviceIndex: 1,
    },
    {
      pid: 456,
      usedMemoryBytes: 300,
      deviceIndex: 1,
    },
  ]);
  assert.equal(binding.processCalls, 2);
});

test("keeps accelerator telemetry ready when process accounting is unsupported", () => {
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  binding.processError = new NvmlError(
    "nvmlDeviceGetComputeRunningProcesses_v3",
    NVML_ERROR_NOT_SUPPORTED,
    "Not Supported",
  );
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  assert.deepEqual(telemetry.computeProcesses(), []);
  assert.equal(telemetry.status().state, "ready");
  assert.equal(binding.shutdownCalls, 0);
});

test("reports missing libraries without throwing from callers", () => {
  const telemetry = new NvidiaTelemetry({
    bindingFactory: () => {
      throw new NvmlLibraryError("libnvidia-ml.so.1 was not found");
    },
  });

  assert.deepEqual(telemetry.accelerators(), []);
  assert.equal(telemetry.status().state, "no-library");
});

test("classifies an unloaded driver and retries after the backoff", () => {
  let now = 0;
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  binding.initError = new NvmlError(
    "nvmlInit_v2",
    NVML_ERROR_DRIVER_NOT_LOADED,
    "Driver Not Loaded",
  );
  const telemetry = new NvidiaTelemetry({
    bindingFactory: () => binding,
    now: () => now,
    retryDelayMs: 10,
  });

  assert.equal(telemetry.status().state, "driver-not-loaded");
  assert.equal(binding.initializeCalls, 1);
  telemetry.status();
  assert.equal(binding.initializeCalls, 1);

  binding.initError = null;
  now = 10;
  assert.equal(telemetry.status().state, "ready");
  assert.equal(binding.initializeCalls, 2);
});

test("keeps the last accelerator snapshot when a GPU is lost", () => {
  let now = 0;
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  const telemetry = new NvidiaTelemetry({
    bindingFactory: () => binding,
    now: () => now,
    acceleratorCacheMs: 10,
  });
  const first = telemetry.accelerators();

  binding.memoryError = new NvmlError(
    "nvmlDeviceGetMemoryInfo",
    NVML_ERROR_GPU_IS_LOST,
    "GPU is lost",
  );
  now = 10;

  assert.deepEqual(telemetry.accelerators(), first);
  assert.equal(telemetry.status().state, "gpu-lost");
  assert.equal(binding.shutdownCalls, 1);
});

test("close balances a successful initialization with shutdown", () => {
  const binding = new FakeNvmlBinding([fakeDevice(0)]);
  const telemetry = new NvidiaTelemetry({ bindingFactory: () => binding });

  telemetry.status();
  telemetry.close();

  assert.equal(binding.initializeCalls, 1);
  assert.equal(binding.shutdownCalls, 1);
  assert.equal(telemetry.status().state, "ready");
  assert.equal(binding.initializeCalls, 2);
});
