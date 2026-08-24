import koffi, { type LibraryHandle } from "koffi";
import {
  type SystemAcceleratorEcc,
  type SystemAcceleratorPcie,
  type SystemAcceleratorRecoveryAction,
  type SystemAcceleratorRemappedRows,
  type SystemAcceleratorRetiredPages,
  type SystemAcceleratorThrottleReason,
} from "@arriero/core";

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
const NVML_MEMORY_ERROR_TYPE_CORRECTED = 0;
const NVML_MEMORY_ERROR_TYPE_UNCORRECTED = 1;
const NVML_AGGREGATE_ECC = 1;
const NVML_FI_DEV_GET_GPU_RECOVERY_ACTION = 230;
const NVML_VALUE_TYPE_UNSIGNED_INT = 1;
const NVML_VALUE_TYPE_UNSIGNED_LONG = 2;
const NVML_VALUE_TYPE_UNSIGNED_LONG_LONG = 3;
const NVML_VALUE_TYPE_UNSIGNED_SHORT = 6;
const NVML_UNSIGNED_VALUE_TYPES = new Set([
  NVML_VALUE_TYPE_UNSIGNED_INT,
  NVML_VALUE_TYPE_UNSIGNED_LONG,
  NVML_VALUE_TYPE_UNSIGNED_LONG_LONG,
  NVML_VALUE_TYPE_UNSIGNED_SHORT,
]);
const NVML_FI_DEV_MEMORY_TEMP = 82;
const NVML_PAGE_RETIREMENT_CAUSE_MULTIPLE_SINGLE_BIT_ECC_ERRORS = 0;
const NVML_PAGE_RETIREMENT_CAUSE_DOUBLE_BIT_ECC_ERROR = 1;
const NVML_CLOCKS_EVENT_REASON_SW_POWER_CAP = 0x4n;
const NVML_CLOCKS_EVENT_REASON_HW_SLOWDOWN = 0x8n;
const NVML_CLOCKS_EVENT_REASON_SW_THERMAL_SLOWDOWN = 0x20n;
const NVML_CLOCKS_EVENT_REASON_HW_THERMAL_SLOWDOWN = 0x40n;
const NVML_CLOCKS_EVENT_REASON_HW_POWER_BRAKE_SLOWDOWN = 0x80n;

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
const NvmlFieldValue = koffi.struct("arriero_nvmlFieldValue_t", {
  fieldId: "uint32_t",
  scopeId: "uint32_t",
  timestamp: "int64_t",
  latencyUsec: "int64_t",
  valueType: "uint32_t",
  nvmlReturn: "int32_t",
  value: "uint64_t",
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

export type NvmlEccErrors = Pick<
  SystemAcceleratorEcc,
  "corrected" | "uncorrected"
>;

export type NvmlRemappedRows = SystemAcceleratorRemappedRows;

export type NvmlGpuRecoveryAction = SystemAcceleratorRecoveryAction;

export type NvmlThrottleReason = SystemAcceleratorThrottleReason;

export type NvmlRetiredPages = SystemAcceleratorRetiredPages;

export type NvmlPcieCurrentLink = Pick<
  SystemAcceleratorPcie,
  "currentGeneration" | "currentWidth"
>;

export type NvmlPcieMaxLink = Pick<
  SystemAcceleratorPcie,
  "maxGeneration" | "maxWidth"
>;

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
  deviceEccErrors(device: NvmlDeviceHandle): NvmlEccErrors | null;
  deviceRemappedRows(device: NvmlDeviceHandle): NvmlRemappedRows | null;
  deviceRetiredPages(device: NvmlDeviceHandle): NvmlRetiredPages | null;
  deviceRecoveryAction(device: NvmlDeviceHandle): NvmlGpuRecoveryAction | null;
  deviceMemoryTemperature(device: NvmlDeviceHandle): number | null;
  deviceThrottleReasons(device: NvmlDeviceHandle): NvmlThrottleReason[] | null;
  devicePcieCurrentLink(device: NvmlDeviceHandle): NvmlPcieCurrentLink | null;
  devicePcieMaxLink(device: NvmlDeviceHandle): NvmlPcieMaxLink | null;
  devicePcieReplayCounter(device: NvmlDeviceHandle): number | null;
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
type NativeFieldValue = {
  fieldId?: number;
  scopeId?: number;
  timestamp?: NativeNumber;
  latencyUsec?: NativeNumber;
  valueType?: number;
  nvmlReturn?: number;
  value?: NativeNumber;
};

const GPU_RECOVERY_ACTIONS: Record<number, SystemAcceleratorRecoveryAction> = {
  0: "none",
  1: "gpu-reset",
  2: "node-reboot",
  3: "drain-p2p",
  4: "drain-and-reset",
  5: "recover-imex-domain",
};

const THROTTLE_REASON_BITS: ReadonlyArray<
  readonly [bigint, NvmlThrottleReason]
> = [
  [NVML_CLOCKS_EVENT_REASON_HW_SLOWDOWN, "hw-slowdown"],
  [NVML_CLOCKS_EVENT_REASON_HW_THERMAL_SLOWDOWN, "hw-thermal"],
  [NVML_CLOCKS_EVENT_REASON_HW_POWER_BRAKE_SLOWDOWN, "hw-power-brake"],
  [NVML_CLOCKS_EVENT_REASON_SW_THERMAL_SLOWDOWN, "sw-thermal"],
  [NVML_CLOCKS_EVENT_REASON_SW_POWER_CAP, "sw-power-cap"],
];

function compactRecord<K extends string>(
  entries: Record<K, number | null>,
): { [P in K]?: number } | null {
  const result: { [P in K]?: number } = {};
  let seen = false;
  for (const key of Object.keys(entries) as K[]) {
    const value = entries[key];
    if (value !== null) {
      result[key] = value;
      seen = true;
    }
  }
  return seen ? result : null;
}

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
  private readonly getTotalEccErrors = this.library.func(
    "nvmlDeviceGetTotalEccErrors",
    "int",
    [
      NvmlDevicePointer,
      "uint32_t",
      "uint32_t",
      koffi.out(koffi.pointer("uint64_t")),
    ],
  );
  private readonly getRemappedRows = this.library.func(
    "nvmlDeviceGetRemappedRows",
    "int",
    [
      NvmlDevicePointer,
      koffi.out(koffi.pointer("uint32_t")),
      koffi.out(koffi.pointer("uint32_t")),
      koffi.out(koffi.pointer("uint32_t")),
      koffi.out(koffi.pointer("uint32_t")),
    ],
  );
  private readonly getFieldValues = this.library.func(
    "nvmlDeviceGetFieldValues",
    "int",
    [NvmlDevicePointer, "int", koffi.inout(koffi.pointer(NvmlFieldValue))],
  );
  private readonly getRetiredPages = this.library.func(
    "nvmlDeviceGetRetiredPages",
    "int",
    [
      NvmlDevicePointer,
      "uint32_t",
      koffi.inout(koffi.pointer("uint32_t")),
      "void *",
    ],
  );
  private readonly getRetiredPagesPendingStatus = this.library.func(
    "nvmlDeviceGetRetiredPagesPendingStatus",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getCurrPcieLinkGeneration = this.library.func(
    "nvmlDeviceGetCurrPcieLinkGeneration",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getCurrPcieLinkWidth = this.library.func(
    "nvmlDeviceGetCurrPcieLinkWidth",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getMaxPcieLinkGeneration = this.library.func(
    "nvmlDeviceGetMaxPcieLinkGeneration",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getMaxPcieLinkWidth = this.library.func(
    "nvmlDeviceGetMaxPcieLinkWidth",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getPcieReplayCounter = this.library.func(
    "nvmlDeviceGetPcieReplayCounter",
    "int",
    [NvmlDevicePointer, koffi.out(koffi.pointer("uint32_t"))],
  );
  private readonly getClocksEventReasons = this.resolveClocksEventReasons();
  private readonly getComputeProcesses = this.library.func(
    "nvmlDeviceGetComputeRunningProcesses_v3",
    "int",
    [NvmlDevicePointer, koffi.inout(koffi.pointer("uint32_t")), "void *"],
  );
  private resolveClocksEventReasons() {
    const parameters = [
      NvmlDevicePointer,
      koffi.out(koffi.pointer("uint64_t")),
    ];
    for (const name of [
      "nvmlDeviceGetCurrentClocksEventReasons",
      "nvmlDeviceGetCurrentClocksThrottleReasons",
    ]) {
      try {
        return this.library.func(name, "int", parameters);
      } catch {
        continue;
      }
    }
    return null;
  }

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
    return this.readDeviceUint(
      "nvmlDeviceGetTemperature",
      (target, output) => this.getDeviceTemperature(target, 0, output),
      device,
    );
  }

  private readAggregateEcc(
    device: NvmlDeviceHandle,
    errorType: number,
  ): number | null {
    const count: Array<bigint | null> = [null];
    const code = this.getTotalEccErrors(
      device,
      errorType,
      NVML_AGGREGATE_ECC,
      count,
    );
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetTotalEccErrors", code);
    return safeUnsigned(count[0] ?? undefined);
  }

  deviceEccErrors(device: NvmlDeviceHandle): NvmlEccErrors | null {
    return compactRecord({
      corrected: this.readAggregateEcc(
        device,
        NVML_MEMORY_ERROR_TYPE_CORRECTED,
      ),
      uncorrected: this.readAggregateEcc(
        device,
        NVML_MEMORY_ERROR_TYPE_UNCORRECTED,
      ),
    });
  }

  deviceRemappedRows(device: NvmlDeviceHandle): NvmlRemappedRows | null {
    const corrected = [0];
    const uncorrected = [0];
    const pending = [0];
    const failure = [0];
    const code = this.getRemappedRows(
      device,
      corrected,
      uncorrected,
      pending,
      failure,
    );
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetRemappedRows", code);
    return {
      corrected: corrected[0] ?? 0,
      uncorrected: uncorrected[0] ?? 0,
      pending: (pending[0] ?? 0) !== 0,
      failure: (failure[0] ?? 0) !== 0,
    };
  }

  private readUnsignedField(
    device: NvmlDeviceHandle,
    fieldId: number,
  ): number | null {
    const field: NativeFieldValue = { fieldId };
    const code = this.getFieldValues(device, 1, field);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetFieldValues", code);
    if (field.nvmlReturn !== NVML_SUCCESS) {
      return null;
    }
    if (
      field.valueType === undefined ||
      !NVML_UNSIGNED_VALUE_TYPES.has(field.valueType)
    ) {
      return null;
    }
    return safeUnsigned(field.value);
  }

  deviceRecoveryAction(device: NvmlDeviceHandle): NvmlGpuRecoveryAction | null {
    const raw = this.readUnsignedField(
      device,
      NVML_FI_DEV_GET_GPU_RECOVERY_ACTION,
    );
    if (raw === null) {
      return null;
    }
    return GPU_RECOVERY_ACTIONS[raw] ?? null;
  }

  deviceMemoryTemperature(device: NvmlDeviceHandle): number | null {
    return this.readUnsignedField(device, NVML_FI_DEV_MEMORY_TEMP);
  }

  private readRetiredPageCount(
    device: NvmlDeviceHandle,
    cause: number,
  ): number | null {
    const count = [0];
    const code = this.getRetiredPages(device, cause, count, null);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    if (code !== NVML_ERROR_INSUFFICIENT_SIZE) {
      this.check("nvmlDeviceGetRetiredPages", code);
    }
    return count[0] ?? null;
  }

  private readRetiredPagesPending(device: NvmlDeviceHandle): boolean | null {
    const pending = [0];
    const code = this.getRetiredPagesPendingStatus(device, pending);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetRetiredPagesPendingStatus", code);
    const value = pending[0];
    return value === undefined ? null : value !== 0;
  }

  deviceRetiredPages(device: NvmlDeviceHandle): NvmlRetiredPages | null {
    const counts = compactRecord({
      corrected: this.readRetiredPageCount(
        device,
        NVML_PAGE_RETIREMENT_CAUSE_MULTIPLE_SINGLE_BIT_ECC_ERRORS,
      ),
      uncorrected: this.readRetiredPageCount(
        device,
        NVML_PAGE_RETIREMENT_CAUSE_DOUBLE_BIT_ECC_ERROR,
      ),
    });
    if (counts === null) {
      return null;
    }
    return { ...counts, pending: this.readRetiredPagesPending(device) };
  }

  deviceThrottleReasons(device: NvmlDeviceHandle): NvmlThrottleReason[] | null {
    if (!this.getClocksEventReasons) {
      return null;
    }
    const output: Array<NativeNumber | null> = [null];
    const code = this.getClocksEventReasons(device, output);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check("nvmlDeviceGetCurrentClocksEventReasons", code);
    const raw = output[0];
    if (raw === null || raw === undefined) {
      return null;
    }
    const mask = typeof raw === "bigint" ? raw : BigInt(raw);
    return THROTTLE_REASON_BITS.filter(([bit]) => (mask & bit) !== 0n).map(
      ([, reason]) => reason,
    );
  }

  private readDeviceUint(
    operation: string,
    read: (device: NvmlDeviceHandle, output: number[]) => number,
    device: NvmlDeviceHandle,
  ): number | null {
    const output = [0];
    const code = read(device, output);
    if (code === NVML_ERROR_NOT_SUPPORTED) {
      return null;
    }
    this.check(operation, code);
    return output[0] ?? null;
  }

  devicePcieCurrentLink(device: NvmlDeviceHandle): NvmlPcieCurrentLink | null {
    return compactRecord({
      currentGeneration: this.readDeviceUint(
        "nvmlDeviceGetCurrPcieLinkGeneration",
        this.getCurrPcieLinkGeneration,
        device,
      ),
      currentWidth: this.readDeviceUint(
        "nvmlDeviceGetCurrPcieLinkWidth",
        this.getCurrPcieLinkWidth,
        device,
      ),
    });
  }

  devicePcieMaxLink(device: NvmlDeviceHandle): NvmlPcieMaxLink | null {
    return compactRecord({
      maxGeneration: this.readDeviceUint(
        "nvmlDeviceGetMaxPcieLinkGeneration",
        this.getMaxPcieLinkGeneration,
        device,
      ),
      maxWidth: this.readDeviceUint(
        "nvmlDeviceGetMaxPcieLinkWidth",
        this.getMaxPcieLinkWidth,
        device,
      ),
    });
  }

  devicePcieReplayCounter(device: NvmlDeviceHandle): number | null {
    return this.readDeviceUint(
      "nvmlDeviceGetPcieReplayCounter",
      this.getPcieReplayCounter,
      device,
    );
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
