import koffi, { type LibraryHandle } from "koffi";

export const NVML_ERROR_NOT_SUPPORTED = 3;
export const NVML_ERROR_NO_PERMISSION = 4;
const NVML_ERROR_INSUFFICIENT_SIZE = 7;
export const NVML_ERROR_DRIVER_NOT_LOADED = 9;
export const NVML_ERROR_GPU_IS_LOST = 15;

const NVML_SUCCESS = 0;
const STRING_BUFFER_SIZE = 96;
const PROCESS_LIST_RETRIES = 3;
const PROCESS_LIST_HEADROOM = 8;
const NVML_VALUE_NOT_AVAILABLE = 0xffff_ffff_ffff_ffffn;

const NvmlDevice = koffi.opaque("arriero_nvmlDevice_st");
const NvmlDevicePointer = koffi.pointer(NvmlDevice);
const NvmlMemory = koffi.struct("arriero_nvmlMemory_t", {
  total: "uint64_t",
  free: "uint64_t",
  used: "uint64_t",
});
const NvmlUtilization = koffi.struct("arriero_nvmlUtilization_t", {
  gpu: "uint32_t",
  memory: "uint32_t",
});
const NvmlPciInfo = koffi.struct("arriero_nvmlPciInfo_t", {
  busIdLegacy: koffi.array("char", 16, "String"),
  domain: "uint32_t",
  bus: "uint32_t",
  device: "uint32_t",
  pciDeviceId: "uint32_t",
  pciSubSystemId: "uint32_t",
  busId: koffi.array("char", 32, "String"),
});
const NvmlProcessInfo = koffi.struct("arriero_nvmlProcessInfo_t", {
  pid: "uint32_t",
  usedGpuMemory: "uint64_t",
  gpuInstanceId: "uint32_t",
  computeInstanceId: "uint32_t",
});

export type NvmlDeviceHandle = bigint;

export type NvmlMemoryInfo = {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
};

export type NvmlProcessInfo = {
  pid: number;
  usedMemoryBytes: number;
};

export type NvmlComputeCapability = {
  major: number;
  minor: number;
};

export interface NvmlBinding {
  initialize(): void;
  shutdown(): void;
  driverVersion(): string;
  deviceCount(): number;
  deviceHandle(index: number): NvmlDeviceHandle;
  deviceName(device: NvmlDeviceHandle): string;
  deviceUuid(device: NvmlDeviceHandle): string;
  devicePciBusId(device: NvmlDeviceHandle): string;
  deviceCudaComputeCapability(
    device: NvmlDeviceHandle,
  ): NvmlComputeCapability | null;
  deviceMemory(device: NvmlDeviceHandle): NvmlMemoryInfo;
  deviceUtilization(device: NvmlDeviceHandle): number | null;
  deviceTemperature(device: NvmlDeviceHandle): number | null;
  computeProcesses(device: NvmlDeviceHandle): NvmlProcessInfo[];
}

export class NvmlLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvmlLibraryError";
  }
}

export class NvmlError extends Error {
  constructor(
    readonly operation: string,
    readonly code: number,
    detail: string,
  ) {
    super(`${operation} failed: ${detail} (NVML ${code})`);
    this.name = "NvmlError";
  }
}

type NativeNumber = number | bigint;
type NativeMemory = {
  total?: NativeNumber;
  free?: NativeNumber;
  used?: NativeNumber;
};
type NativeUtilization = {
  gpu?: number;
  memory?: number;
};
type NativePciInfo = {
  busId?: string | number[];
  busIdLegacy?: string | number[];
};
type NativeProcessInfo = {
  pid?: number;
  usedGpuMemory?: NativeNumber;
};

function libraryCandidates(platform = process.platform): string[] {
  if (platform === "linux") {
    return ["libnvidia-ml.so.1"];
  }
  if (platform === "win32") {
    return ["nvml.dll"];
  }
  return [];
}

function loadLibrary(platform = process.platform): LibraryHandle {
  const candidates = libraryCandidates(platform);
  if (candidates.length === 0) {
    throw new NvmlLibraryError(`NVML is not supported on ${platform}`);
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return koffi.load(candidate);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new NvmlLibraryError(
    `Unable to load ${candidates.join(" or ")}: ${failures.join("; ")}`,
  );
}

function decodeCString(buffer: Buffer): string {
  const terminator = buffer.indexOf(0);
  return buffer
    .subarray(0, terminator < 0 ? buffer.length : terminator)
    .toString("utf8");
}

function decodeCharArray(value: string | number[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return "";
  }
  const terminator = value.indexOf(0);
  return Buffer.from(value.slice(0, terminator < 0 ? value.length : terminator))
    .toString("utf8")
    .trim();
}

function safeUnsigned(value: NativeNumber | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const asBigInt = typeof value === "bigint" ? value : BigInt(value);
  if (
    asBigInt < 0n ||
    asBigInt === NVML_VALUE_NOT_AVAILABLE ||
    asBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Number(asBigInt);
}

class KoffiNvmlBinding implements NvmlBinding {
  private readonly library = loadLibrary();
  private readonly errorString = this.library.func("nvmlErrorString", "str", [
    "int",
  ]);
  private readonly init = this.library.func("nvmlInit_v2", "int", []);
  private readonly close = this.library.func("nvmlShutdown", "int", []);
  private readonly getDriverVersion = this.library.func(
    "nvmlSystemGetDriverVersion",
    "int",
    ["void *", "uint32_t"],
  );
  private readonly getDeviceCount = this.library.func(
    "nvmlDeviceGetCount_v2",
    "int",
    [koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getDeviceHandle = this.library.func(
    "nvmlDeviceGetHandleByIndex_v2",
    "int",
    ["uint32_t", koffi.out(koffi.pointer(NvmlDevice, 2))],
  );
  private readonly getDeviceName = this.library.func(
    "nvmlDeviceGetName",
    "int",
    [NvmlDevicePointer, "void *", "uint32_t"],
  );
  private readonly getDeviceUuid = this.library.func(
    "nvmlDeviceGetUUID",
    "int",
    [NvmlDevicePointer, "void *", "uint32_t"],
  );
  private readonly getDevicePciInfo = this.library.func(
    "nvmlDeviceGetPciInfo_v3",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer(NvmlPciInfo))],
  );
  private readonly getCudaComputeCapability = this.library.func(
    "nvmlDeviceGetCudaComputeCapability",
    "int",
    [
      NvmlDevicePointer,
      koffi.out(koffi.pointer("int")),
      koffi.out(koffi.pointer("int")),
    ],
  );
  private readonly getDeviceMemory = this.library.func(
    "nvmlDeviceGetMemoryInfo",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer(NvmlMemory))],
  );
  private readonly getDeviceUtilization = this.library.func(
    "nvmlDeviceGetUtilizationRates",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer(NvmlUtilization))],
  );
  private readonly getDeviceTemperature = this.library.func(
    "nvmlDeviceGetTemperature",
    "int",
    [NvmlDevicePointer, "uint32_t", koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getComputeProcesses = this.library.func(
    "nvmlDeviceGetComputeRunningProcesses_v3",
    "int",
    [NvmlDevicePointer, koffi.inout(koffi.pointer("uint32_t")), "void *"],
  );
  private detail(code: number): string {
    try {
      return String(this.errorString(code));
    } catch {
      return "unknown error";
    }
  }

  private check(operation: string, code: number): void {
    if (code !== NVML_SUCCESS) {
      throw new NvmlError(operation, code, this.detail(code));
    }
  }

  initialize(): void {
    this.check("nvmlInit_v2", this.init());
  }

  shutdown(): void {
    this.check("nvmlShutdown", this.close());
  }

  driverVersion(): string {
    const buffer = Buffer.alloc(STRING_BUFFER_SIZE);
    this.check(
      "nvmlSystemGetDriverVersion",
      this.getDriverVersion(buffer, buffer.length),
    );
    return decodeCString(buffer);
  }

  deviceCount(): number {
    const count = [0];
    this.check("nvmlDeviceGetCount_v2", this.getDeviceCount(count));
    return count[0] ?? 0;
  }

  deviceHandle(index: number): NvmlDeviceHandle {
    const output: Array<bigint | null> = [null];
    this.check(
      "nvmlDeviceGetHandleByIndex_v2",
      this.getDeviceHandle(index, output),
    );
    const device = output[0];
    if (device === null || device === undefined) {
      throw new NvmlError(
        "nvmlDeviceGetHandleByIndex_v2",
        -1,
        "NVML returned a null device handle",
      );
    }
    return device;
  }

  private deviceString(
    operation: string,
    call: (device: NvmlDeviceHandle, buffer: Buffer, size: number) => number,
    device: NvmlDeviceHandle,
  ): string {
    const buffer = Buffer.alloc(STRING_BUFFER_SIZE);
    this.check(operation, call(device, buffer, buffer.length));
    return decodeCString(buffer);
  }

  deviceName(device: NvmlDeviceHandle): string {
    return this.deviceString("nvmlDeviceGetName", this.getDeviceName, device);
  }

  deviceUuid(device: NvmlDeviceHandle): string {
    return this.deviceString("nvmlDeviceGetUUID", this.getDeviceUuid, device);
  }

  devicePciBusId(device: NvmlDeviceHandle): string {
    const pci: NativePciInfo = {};
    this.check("nvmlDeviceGetPciInfo_v3", this.getDevicePciInfo(device, pci));
    return decodeCharArray(pci.busId) || decodeCharArray(pci.busIdLegacy);
  }

  deviceCudaComputeCapability(
    device: NvmlDeviceHandle,
  ): NvmlComputeCapability | null {
    const major = [0];
    const minor = [0];
    const code = this.getCudaComputeCapability(device, major, minor);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetCudaComputeCapability", code);
    const majorValue = major[0];
    const minorValue = minor[0];
    if (
      majorValue === undefined ||
      minorValue === undefined ||
      !Number.isInteger(majorValue) ||
      majorValue < 0 ||
      !Number.isInteger(minorValue) ||
      minorValue < 0
    ) {
      return null;
    }
    return { major: majorValue, minor: minorValue };
  }

  deviceMemory(device: NvmlDeviceHandle): NvmlMemoryInfo {
    const memory: NativeMemory = {};
    this.check("nvmlDeviceGetMemoryInfo", this.getDeviceMemory(device, memory));
    const totalBytes = safeUnsigned(memory.total);
    const freeBytes = safeUnsigned(memory.free);
    const usedBytes = safeUnsigned(memory.used);
    if (totalBytes === null || freeBytes === null || usedBytes === null) {
      throw new NvmlError(
        "nvmlDeviceGetMemoryInfo",
        -1,
        "NVML returned an invalid memory value",
      );
    }
    return { totalBytes, freeBytes, usedBytes };
  }

  deviceUtilization(device: NvmlDeviceHandle): number | null {
    const utilization: NativeUtilization = {};
    const code = this.getDeviceUtilization(device, utilization);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetUtilizationRates", code);
    return utilization.gpu ?? null;
  }

  deviceTemperature(device: NvmlDeviceHandle): number | null {
    const temperature = [0];
    const code = this.getDeviceTemperature(device, 0, temperature);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetTemperature", code);
    return temperature[0] ?? null;
  }

  computeProcesses(device: NvmlDeviceHandle): NvmlProcessInfo[] {
    let capacity = 0;
    for (let attempt = 0; attempt < PROCESS_LIST_RETRIES; attempt += 1) {
      const count = [capacity];
      const buffer =
        capacity === 0
          ? null
          : Buffer.alloc(capacity * koffi.sizeof(NvmlProcessInfo));
      const code = this.getComputeProcesses(device, count, buffer);
      if (code === NVML_SUCCESS) {
        if (!buffer || (count[0] ?? 0) === 0) {
          return [];
        }
        const decoded = koffi.decode(
          buffer,
          NvmlProcessInfo,
          count[0] ?? 0,
        ) as NativeProcessInfo[];
        return decoded.flatMap((processInfo): NvmlProcessInfo[] => {
          const pid = processInfo.pid;
          const usedMemoryBytes = safeUnsigned(processInfo.usedGpuMemory);
          if (
            pid === undefined ||
            !Number.isInteger(pid) ||
            pid <= 0 ||
            usedMemoryBytes === null
          ) {
            return [];
          }
          return [{ pid, usedMemoryBytes }];
        });
      }
      if (code !== NVML_ERROR_INSUFFICIENT_SIZE) {
        this.check("nvmlDeviceGetComputeRunningProcesses_v3", code);
      }
      capacity = Math.max(
        capacity + PROCESS_LIST_HEADROOM,
        (count[0] ?? 0) + PROCESS_LIST_HEADROOM,
      );
    }
    throw new NvmlError(
      "nvmlDeviceGetComputeRunningProcesses_v3",
      NVML_ERROR_INSUFFICIENT_SIZE,
      "process list kept growing while it was read",
    );
  }
}

export function createKoffiNvmlBinding(): NvmlBinding {
  return new KoffiNvmlBinding();
}
