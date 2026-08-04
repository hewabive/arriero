import { readdirSync, readlinkSync } from "node:fs";
import { basename, resolve } from "node:path";

import { readSysString } from "./sysfs.js";

const PCI_DEVICES_PATH = "/sys/bus/pci/devices";
const PCI_DISPLAY_BASE_CLASS = 0x03;

export type PciDisplayVendor = {
  id: number;
  label: string;
};

export const NVIDIA_PCI_VENDOR: PciDisplayVendor = {
  id: 0x10de,
  label: "NVIDIA",
};

export const AMD_PCI_VENDOR: PciDisplayVendor = {
  id: 0x1002,
  label: "AMD",
};

type DisplayPciDevice = {
  address: string;
  deviceId: string | null;
  classCode: string;
  driver: string | null;
};

export type DisplayPciInventory =
  | {
      state: "present";
      devices: DisplayPciDevice[];
      detail: string;
    }
  | {
      state: "absent" | "unknown";
      devices: [];
      detail: string;
    };

function parsePciHex(value: string | null): number | null {
  if (!value || !/^0x[0-9a-f]+$/i.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function boundDriver(devicePath: string): string | null {
  try {
    return basename(readlinkSync(resolve(devicePath, "driver")));
  } catch {
    return null;
  }
}

export function detectDisplayPciInventory(
  vendor: PciDisplayVendor,
  devicesPath = PCI_DEVICES_PATH,
): DisplayPciInventory {
  let addresses: string[];
  try {
    addresses = readdirSync(devicesPath);
  } catch (error) {
    return {
      state: "unknown",
      devices: [],
      detail: `Unable to inspect PCI devices: ${(error as Error).message}`,
    };
  }

  const devices: DisplayPciDevice[] = [];
  let unreadableDevices = 0;
  for (const address of addresses) {
    const devicePath = resolve(devicesPath, address);
    const vendorText = readSysString(resolve(devicePath, "vendor"));
    const classText = readSysString(resolve(devicePath, "class"));
    const vendorId = parsePciHex(vendorText);
    const classCode = parsePciHex(classText);
    if (vendorId === null || classCode === null) {
      unreadableDevices += 1;
      continue;
    }
    if (
      vendorId !== vendor.id ||
      ((classCode >> 16) & 0xff) !== PCI_DISPLAY_BASE_CLASS
    ) {
      continue;
    }
    devices.push({
      address,
      deviceId: readSysString(resolve(devicePath, "device")),
      classCode: classText!,
      driver: boundDriver(devicePath),
    });
  }

  if (devices.length > 0) {
    const bindings = devices
      .map((device) => `${device.address} (${device.driver ?? "unbound"})`)
      .join(", ");
    return {
      state: "present",
      devices,
      detail: `${devices.length} ${vendor.label} display controller${devices.length === 1 ? "" : "s"} detected through PCI: ${bindings}`,
    };
  }
  if (unreadableDevices > 0) {
    return {
      state: "unknown",
      devices: [],
      detail: `PCI inventory was incomplete: ${unreadableDevices} device entr${unreadableDevices === 1 ? "y was" : "ies were"} unreadable`,
    };
  }
  return {
    state: "absent",
    devices: [],
    detail: `No ${vendor.label} display controller was detected through PCI`,
  };
}

export function detectNvidiaPciInventory(
  devicesPath = PCI_DEVICES_PATH,
): DisplayPciInventory {
  return detectDisplayPciInventory(NVIDIA_PCI_VENDOR, devicesPath);
}

export function detectAmdPciInventory(
  devicesPath = PCI_DEVICES_PATH,
): DisplayPciInventory {
  return detectDisplayPciInventory(AMD_PCI_VENDOR, devicesPath);
}

export function displayPciInventoryUsesVfio(
  inventory: DisplayPciInventory,
): boolean {
  return (
    inventory.state === "present" &&
    inventory.devices.some((device) => device.driver === "vfio-pci")
  );
}
