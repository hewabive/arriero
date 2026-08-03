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
      versionId: "24.04",
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "linuxmint",
      idLike: ["ubuntu", "debian"],
      prettyName: "Linux Mint",
      versionId: null,
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
});

test("uses NVIDIA's hardware-aware driver assistant on Rocky Linux 9 x86-64", () => {
  assert.deepEqual(
    nvidiaDriverInstallCommands(
      {
        id: "rocky",
        idLike: ["rhel", "centos", "fedora"],
        prettyName: "Rocky Linux 9.8 (Blue Onyx)",
        versionId: "9.8",
      },
      "x64",
    ),
    [
      "sudo dnf config-manager --set-enabled crb",
      "sudo dnf install -y epel-release kernel-devel-matched kernel-headers",
      "sudo dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/rhel9/x86_64/cuda-rhel9.repo",
      "sudo dnf clean expire-cache",
      "sudo dnf install -y nvidia-driver-assistant",
      "nvidia-driver-assistant --install",
      "sudo reboot",
    ],
  );
});

test("does not suggest distro-specific driver commands on unsupported hosts", () => {
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "debian",
      idLike: [],
      prettyName: "Debian GNU/Linux",
      versionId: "13",
    }),
    [],
  );
  assert.deepEqual(
    nvidiaDriverInstallCommands(
      {
        id: "rocky",
        idLike: ["rhel", "centos", "fedora"],
        prettyName: "Rocky Linux 9.8 (Blue Onyx)",
        versionId: "9.8",
      },
      "arm64",
    ),
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
