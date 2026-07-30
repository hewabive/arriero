import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nvidiaDriverInstallCommands,
  nvidiaDriverProbeOutcome,
} from "./registry.js";

test("uses ubuntu-drivers for Ubuntu and its derivatives", () => {
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "ubuntu",
      idLike: ["debian"],
      prettyName: "Ubuntu 24.04 LTS",
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "linuxmint",
      idLike: ["ubuntu", "debian"],
      prettyName: "Linux Mint",
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
});

test("does not suggest Ubuntu driver commands on other distributions", () => {
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "debian",
      idLike: [],
      prettyName: "Debian GNU/Linux",
    }),
    [],
  );
});

test("maps NVML provider states to prerequisite outcomes", () => {
  assert.deepEqual(
    nvidiaDriverProbeOutcome({
      state: "ready",
      detail: "1 NVIDIA GPU available through NVML",
      driverVersion: "595.71.05",
      deviceCount: 1,
    }),
    {
      status: "ok",
      detail: "1 NVIDIA GPU available through NVML",
      version: "595.71.05",
    },
  );
  assert.equal(
    nvidiaDriverProbeOutcome({
      state: "driver-not-loaded",
      detail: "Driver Not Loaded",
      driverVersion: null,
      deviceCount: 0,
    }).status,
    "missing",
  );
  assert.equal(
    nvidiaDriverProbeOutcome({
      state: "permission-denied",
      detail: "No Permission",
      driverVersion: null,
      deviceCount: 0,
    }).status,
    "unknown",
  );
});
