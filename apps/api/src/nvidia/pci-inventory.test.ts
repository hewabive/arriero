import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import {
  detectNvidiaPciInventory,
  nvidiaPciInventoryUsesVfio,
} from "./pci-inventory.js";

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "arriero-pci-"));
  const root = join(temporary, "devices");
  const drivers = join(temporary, "drivers");
  mkdirSync(root);
  mkdirSync(drivers);
  const add = (input: {
    address: string;
    vendor: string;
    device?: string;
    classCode: string;
    driver?: string;
  }) => {
    const path = join(root, input.address);
    mkdirSync(path);
    writeFileSync(join(path, "vendor"), `${input.vendor}\n`);
    writeFileSync(join(path, "device"), `${input.device ?? "0x0001"}\n`);
    writeFileSync(join(path, "class"), `${input.classCode}\n`);
    if (input.driver) {
      const driver = join(drivers, input.driver);
      mkdirSync(driver, { recursive: true });
      symlinkSync(driver, join(path, "driver"));
    }
  };
  return {
    root,
    add,
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

test("detects NVIDIA display controllers without an NVIDIA driver", () => {
  const subject = fixture();
  try {
    subject.add({
      address: "0000:06:00.0",
      vendor: "0x10de",
      device: "0x2231",
      classCode: "0x030000",
      driver: "nouveau",
    });
    subject.add({
      address: "0000:07:00.0",
      vendor: "0x10de",
      classCode: "0x040300",
      driver: "snd_hda_intel",
    });

    const result = detectNvidiaPciInventory(subject.root);
    assert.equal(result.state, "present");
    assert.equal(result.devices.length, 1);
    assert.equal(result.devices[0]?.address, "0000:06:00.0");
    assert.equal(result.devices[0]?.driver, "nouveau");
    assert.match(result.detail, /NVIDIA display controller/);
  } finally {
    subject.cleanup();
  }
});

test("reports an authoritative absence when readable PCI devices contain no NVIDIA GPU", () => {
  const subject = fixture();
  try {
    subject.add({
      address: "0000:00:02.0",
      vendor: "0x8086",
      classCode: "0x030000",
    });
    subject.add({
      address: "0000:00:1f.3",
      vendor: "0x8086",
      classCode: "0x040300",
    });
    assert.equal(detectNvidiaPciInventory(subject.root).state, "absent");
  } finally {
    subject.cleanup();
  }
});

test("does not turn an unreadable inventory into an authoritative absence", () => {
  const subject = fixture();
  try {
    mkdirSync(join(subject.root, "0000:00:00.0"));
    assert.equal(detectNvidiaPciInventory(subject.root).state, "unknown");
  } finally {
    subject.cleanup();
  }
});

test("recognises an NVIDIA GPU reserved through vfio-pci", () => {
  const subject = fixture();
  try {
    subject.add({
      address: "0000:06:00.0",
      vendor: "0x10de",
      classCode: "0x030200",
      driver: "vfio-pci",
    });
    const result = detectNvidiaPciInventory(subject.root);
    assert.equal(result.state, "present");
    assert.equal(result.devices[0]?.driver, basename("vfio-pci"));
    assert.equal(nvidiaPciInventoryUsesVfio(result), true);
  } finally {
    subject.cleanup();
  }
});
