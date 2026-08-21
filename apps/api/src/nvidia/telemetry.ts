import {
  createKoffiNvmlBinding,
  type NvmlBinding,
  type NvmlComputeCapability,
  type NvmlDeviceHandle,
  NvmlError,
  NVML_ERROR_DRIVER_NOT_LOADED,
  NVML_ERROR_GPU_IS_LOST,
  NVML_ERROR_NO_PERMISSION,
  NVML_ERROR_NOT_SUPPORTED,
  NvmlLibraryError,
} from "./nvml-binding.js";

const ACCELERATOR_CACHE_MS = 3_000;
const PROCESS_CACHE_MS = 2_000;
const RETRY_DELAY_MS = 3_000;

type NvidiaTelemetryState =
  | "unchecked"
  | "ready"
  | "no-library"
  | "driver-not-loaded"
  | "permission-denied"
  | "no-devices"
  | "gpu-lost"
  | "error";

export type NvidiaTelemetryStatus = {
  state: NvidiaTelemetryState;
  detail: string | null;
  driverVersion: string | null;
  deviceCount: number;
};

export type NvidiaDeviceSnapshot = {
  index: number;
  name: string;
  uuid: string;
  pciBusId: string;
  computeCapability: NvmlComputeCapability | null;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usedMemoryBytes: number;
  utilizationPercent: number | null;
  temperatureC: number | null;
};

export type NvidiaComputeProcess = {
  pid: number;
  usedMemoryBytes: number;
  deviceIndex: number;
};

type InventoryDevice = {
  index: number;
  handle: NvmlDeviceHandle;
  name: string;
  uuid: string;
  pciBusId: string;
  computeCapability: NvmlComputeCapability | null;
};

type TimedCache<T> = {
  value: T;
  expiresAt: number;
};

type NvidiaTelemetryOptions = {
  bindingFactory?: () => NvmlBinding;
  now?: () => number;
  acceleratorCacheMs?: number;
  processCacheMs?: number;
  retryDelayMs?: number;
};

function initialStatus(): NvidiaTelemetryStatus {
  return {
    state: "unchecked",
    detail: null,
    driverVersion: null,
    deviceCount: 0,
  };
}

export class NvidiaTelemetry {
  private readonly bindingFactory: () => NvmlBinding;
  private readonly now: () => number;
  private readonly acceleratorCacheMs: number;
  private readonly processCacheMs: number;
  private readonly retryDelayMs: number;
  private binding: NvmlBinding | null = null;
  private initialized = false;
  private inventory: InventoryDevice[] | null = null;
  private retryAfter = 0;
  private statusValue = initialStatus();
  private acceleratorsCache: TimedCache<NvidiaDeviceSnapshot[]> | null = null;
  private processesCache: TimedCache<NvidiaComputeProcess[]> | null = null;

  constructor(options: NvidiaTelemetryOptions = {}) {
    this.bindingFactory = options.bindingFactory ?? createKoffiNvmlBinding;
    this.now = options.now ?? Date.now;
    this.acceleratorCacheMs =
      options.acceleratorCacheMs ?? ACCELERATOR_CACHE_MS;
    this.processCacheMs = options.processCacheMs ?? PROCESS_CACHE_MS;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  private resetSession(): void {
    if (this.initialized && this.binding) {
      try {
        this.binding.shutdown();
      } catch {}
    }
    this.initialized = false;
    this.binding = null;
    this.inventory = null;
  }

  private fail(error: unknown): void {
    let state: NvidiaTelemetryState = "error";
    if (error instanceof NvmlLibraryError) {
      state = "no-library";
    } else if (error instanceof NvmlError) {
      if (error.code === NVML_ERROR_DRIVER_NOT_LOADED) {
        state = "driver-not-loaded";
      } else if (error.code === NVML_ERROR_NO_PERMISSION) {
        state = "permission-denied";
      } else if (error.code === NVML_ERROR_GPU_IS_LOST) {
        state = "gpu-lost";
      }
    }
    this.statusValue = {
      state,
      detail: error instanceof Error ? error.message : String(error),
      driverVersion: null,
      deviceCount: 0,
    };
    this.retryAfter = this.now() + this.retryDelayMs;
    this.resetSession();
  }

  private ensureInventory(force = false): boolean {
    if (
      this.statusValue.state === "ready" &&
      this.initialized &&
      this.inventory
    ) {
      return true;
    }
    if (!force && this.now() < this.retryAfter) {
      return false;
    }

    try {
      this.binding ??= this.bindingFactory();
      if (!this.initialized) {
        this.binding.initialize();
        this.initialized = true;
      }
      const driverVersion = this.binding.driverVersion();
      const count = this.binding.deviceCount();
      if (count === 0) {
        this.inventory = null;
        this.statusValue = {
          state: "no-devices",
          detail: "The NVIDIA driver is loaded, but NVML reported no devices",
          driverVersion,
          deviceCount: 0,
        };
        this.retryAfter = this.now() + this.retryDelayMs;
        return false;
      }

      const inventory: InventoryDevice[] = [];
      for (let index = 0; index < count; index += 1) {
        const handle = this.binding.deviceHandle(index);
        inventory.push({
          index,
          handle,
          name: this.binding.deviceName(handle),
          uuid: this.binding.deviceUuid(handle),
          pciBusId: this.binding.devicePciBusId(handle),
          computeCapability: this.binding.deviceCudaComputeCapability(handle),
        });
      }
      this.inventory = inventory;
      this.retryAfter = 0;
      this.statusValue = {
        state: "ready",
        detail: `${count} NVIDIA GPU${count === 1 ? "" : "s"} available through NVML`,
        driverVersion,
        deviceCount: count,
      };
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  status(force = false): NvidiaTelemetryStatus {
    this.ensureInventory(force);
    return { ...this.statusValue };
  }

  accelerators(): NvidiaDeviceSnapshot[] {
    const now = this.now();
    if (this.acceleratorsCache && now < this.acceleratorsCache.expiresAt) {
      return this.acceleratorsCache.value;
    }
    if (!this.ensureInventory()) {
      return this.acceleratorsCache?.value ?? [];
    }

    try {
      const value = this.inventory!.map((device) => {
        const memory = this.binding!.deviceMemory(device.handle);
        return {
          index: device.index,
          name: device.name,
          uuid: device.uuid,
          pciBusId: device.pciBusId,
          computeCapability: device.computeCapability,
          totalMemoryBytes: memory.totalBytes,
          freeMemoryBytes: memory.freeBytes,
          usedMemoryBytes: memory.usedBytes,
          utilizationPercent: this.binding!.deviceUtilization(device.handle),
          temperatureC: this.binding!.deviceTemperature(device.handle),
        };
      });
      this.acceleratorsCache = {
        value,
        expiresAt: now + this.acceleratorCacheMs,
      };
      return value;
    } catch (error) {
      this.fail(error);
      return this.acceleratorsCache?.value ?? [];
    }
  }

  private computeProcessesForDevice(
    device: InventoryDevice,
  ): NvidiaComputeProcess[] {
    try {
      return this.binding!.computeProcesses(device.handle).map(
        (processInfo) => ({
          pid: processInfo.pid,
          usedMemoryBytes: processInfo.usedMemoryBytes,
          deviceIndex: device.index,
        }),
      );
    } catch (error) {
      if (
        error instanceof NvmlError &&
        (error.code === NVML_ERROR_NOT_SUPPORTED ||
          error.code === NVML_ERROR_NO_PERMISSION)
      ) {
        return [];
      }
      throw error;
    }
  }

  computeProcesses(): NvidiaComputeProcess[] {
    const now = this.now();
    if (this.processesCache && now < this.processesCache.expiresAt) {
      return this.processesCache.value;
    }
    if (!this.ensureInventory()) {
      return this.processesCache?.value ?? [];
    }

    try {
      const value = this.inventory!.flatMap((device) =>
        this.computeProcessesForDevice(device),
      ).sort(
        (left, right) =>
          left.pid - right.pid || left.deviceIndex - right.deviceIndex,
      );
      this.processesCache = {
        value,
        expiresAt: now + this.processCacheMs,
      };
      return value;
    } catch (error) {
      this.fail(error);
      return this.processesCache?.value ?? [];
    }
  }

  close(): void {
    this.resetSession();
    this.acceleratorsCache = null;
    this.processesCache = null;
    this.statusValue = initialStatus();
    this.retryAfter = 0;
  }
}

export const nvidiaTelemetry = new NvidiaTelemetry();
