import assert from "node:assert/strict";
import { test } from "node:test";
import type { OsRelease } from "../system/os-release.js";
import {
  cudaToolkitInstallCommands,
  nvidiaDriverInstallCommands,
  nvidiaDriverProbeOutcome,
  nvidiaSmiInstallCommands,
  prerequisiteDefinitions,
  uvInstallCommands,
} from "./registry.js";

const ubuntu2404: OsRelease = {
  id: "ubuntu",
  idLike: ["debian"],
  prettyName: "Ubuntu 24.04 LTS",
  versionId: "24.04",
};

const ubuntuNvidiaUtilsDetection =
  "nvidia_utils_package=\"$(ubuntu-drivers list --gpgpu --recommended | sed -nE 's/^nvidia-driver-([0-9]+(-server)?)(-open)?([[:space:]].*)?$/nvidia-utils-\\1/p' | head -n 1)\"";

const rocky9: OsRelease = {
  id: "rocky",
  idLike: ["rhel", "centos", "fedora"],
  prettyName: "Rocky Linux 9.8 (Blue Onyx)",
  versionId: "9.8",
};

const almalinux9: OsRelease = {
  id: "almalinux",
  idLike: ["rhel", "centos", "fedora"],
  prettyName: "AlmaLinux 9.7 (Moss Jungle Cat)",
  versionId: "9.7",
};

const rhel9: OsRelease = {
  id: "rhel",
  idLike: ["fedora"],
  prettyName: "Red Hat Enterprise Linux 9.6 (Plow)",
  versionId: "9.6",
};

const nvidiaPci = {
  state: "present" as const,
  devices: [
    {
      address: "0000:01:00.0",
      deviceId: "0x2231",
      classCode: "0x030000",
      driver: "nouveau",
    },
  ],
  detail: "1 NVIDIA display controller detected through PCI",
};

test("keeps CUDA out of the aggregated DNF transaction", () => {
  const nvcc = prerequisiteDefinitions.find(
    (definition) => definition.id === "nvcc",
  );
  assert.ok(nvcc);
  assert.deepEqual(nvcc.packages.dnf, undefined);
  assert.equal(typeof nvcc.installCommands, "function");
});

const pipxUv = "pipx install uv";

test("bootstraps pipx before uv on Arch and Alpine", () => {
  assert.deepEqual(
    uvInstallCommands(
      {
        id: "arch",
        idLike: [],
        prettyName: "Arch Linux",
        versionId: null,
      },
      false,
    ),
    ["sudo pacman -S --needed python-pipx", pipxUv],
  );
  assert.deepEqual(
    uvInstallCommands(
      {
        id: "alpine",
        idLike: [],
        prettyName: "Alpine Linux",
        versionId: "3.23",
      },
      true,
    ),
    [pipxUv],
  );
});

test("uses an existing pipx without reinstalling it", () => {
  assert.deepEqual(uvInstallCommands(ubuntu2404, true), [pipxUv]);
  assert.deepEqual(uvInstallCommands(rocky9, true), [pipxUv]);
});

test("bootstraps pipx from supported distro packages before installing uv", () => {
  assert.deepEqual(uvInstallCommands(ubuntu2404, false), [
    "sudo apt install -y pipx",
    pipxUv,
  ]);
  assert.deepEqual(
    uvInstallCommands(
      {
        id: "fedora",
        idLike: [],
        prettyName: "Fedora Linux 44",
        versionId: "44",
      },
      false,
    ),
    ["sudo dnf install -y pipx", pipxUv],
  );
  assert.deepEqual(uvInstallCommands(rocky9, false), [
    "sudo dnf install -y pipx",
    pipxUv,
  ]);
  assert.deepEqual(uvInstallCommands(rhel9, false), [
    "sudo dnf install -y pipx",
    pipxUv,
  ]);
});

test("uses the official standalone uv installer on other hosts without pipx", () => {
  assert.deepEqual(
    uvInstallCommands(
      {
        id: "opensuse-leap",
        idLike: ["suse", "opensuse"],
        prettyName: "openSUSE Leap",
        versionId: "16.0",
      },
      false,
    ),
    ["curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh"],
  );
});

test("adds NVIDIA's CUDA repository before installing the toolkit on Fedora", () => {
  assert.deepEqual(
    cudaToolkitInstallCommands(
      {
        id: "fedora",
        idLike: [],
        prettyName: "Fedora Linux 44",
        versionId: "44",
      },
      "x64",
    ),
    [
      "sudo dnf config-manager addrepo --from-repofile=https://developer.download.nvidia.com/compute/cuda/repos/fedora44/x86_64/cuda-fedora44.repo",
      "sudo dnf clean expire-cache",
      "sudo dnf install -y cuda-toolkit",
    ],
  );
});

test("uses the matching RHEL CUDA repository for Rocky Linux", () => {
  assert.deepEqual(cudaToolkitInstallCommands(rocky9, "x64"), [
    "sudo dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/rhel9/x86_64/cuda-rhel9.repo",
    "sudo dnf clean expire-cache",
    "sudo dnf install -y cuda-toolkit",
  ]);
});

test("does not invent CUDA repository commands for unsupported DNF hosts", () => {
  assert.deepEqual(
    cudaToolkitInstallCommands(
      {
        id: "centos",
        idLike: ["rhel", "fedora"],
        prettyName: "CentOS Stream 10",
        versionId: "10",
      },
      "x64",
    ),
    [],
  );
  assert.deepEqual(cudaToolkitInstallCommands(rocky9, "arm64"), []);
});

test("uses ubuntu-drivers for Ubuntu and its derivatives", () => {
  assert.deepEqual(nvidiaDriverInstallCommands(ubuntu2404), [
    ubuntuNvidiaUtilsDetection,
    'test -n "$nvidia_utils_package"',
    "sudo ubuntu-drivers install --gpgpu",
    'sudo apt-get install -y "$nvidia_utils_package"',
  ]);
  assert.deepEqual(
    nvidiaDriverInstallCommands({
      id: "linuxmint",
      idLike: ["ubuntu", "debian"],
      prettyName: "Linux Mint",
      versionId: null,
    }),
    [
      ubuntuNvidiaUtilsDetection,
      'test -n "$nvidia_utils_package"',
      "sudo ubuntu-drivers install --gpgpu",
      'sudo apt-get install -y "$nvidia_utils_package"',
    ],
  );
});

test("installs nvidia-smi from the driver-matched Ubuntu package", () => {
  assert.deepEqual(nvidiaSmiInstallCommands(ubuntu2404), [
    ubuntuNvidiaUtilsDetection,
    'test -n "$nvidia_utils_package"',
    'sudo apt-get install -y "$nvidia_utils_package"',
  ]);
});

test("uses NVIDIA's hardware-aware driver assistant on Rocky Linux 9 x86-64", () => {
  assert.deepEqual(nvidiaDriverInstallCommands(rocky9, "x64"), [
    "sudo dnf config-manager --set-enabled crb",
    "sudo dnf install -y epel-release kernel-devel-matched kernel-headers",
    "sudo dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/rhel9/x86_64/cuda-rhel9.repo",
    "sudo dnf clean expire-cache",
    "sudo dnf install -y nvidia-driver-assistant",
    "nvidia-driver-assistant --install",
    "sudo dnf install -y nvidia-driver-cuda",
  ]);
  assert.deepEqual(nvidiaSmiInstallCommands(rocky9, "x64"), [
    "sudo dnf install -y nvidia-driver-cuda",
  ]);
});

test("uses AlmaLinux's precompiled NVIDIA driver packages on AlmaLinux 9", () => {
  const expectedDriverCommands = [
    "sudo dnf install -y almalinux-release-nvidia-driver",
    "sudo dnf install -y nvidia-open-kmod nvidia-driver nvidia-driver-cuda",
  ];
  const expectedSmiCommands = [
    "sudo dnf install -y almalinux-release-nvidia-driver",
    "sudo dnf install -y nvidia-driver-cuda",
  ];

  assert.deepEqual(
    nvidiaDriverInstallCommands(almalinux9, "x64"),
    expectedDriverCommands,
  );
  assert.deepEqual(
    nvidiaDriverInstallCommands(almalinux9, "arm64"),
    expectedDriverCommands,
  );
  assert.deepEqual(
    nvidiaSmiInstallCommands(almalinux9, "x64"),
    expectedSmiCommands,
  );
  assert.deepEqual(
    nvidiaSmiInstallCommands(almalinux9, "arm64"),
    expectedSmiCommands,
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
  assert.deepEqual(nvidiaDriverInstallCommands(rocky9, "arm64"), []);
  assert.deepEqual(nvidiaSmiInstallCommands(rocky9, "arm64"), []);
  assert.deepEqual(nvidiaDriverInstallCommands(almalinux9, "ia32"), []);
  assert.deepEqual(nvidiaSmiInstallCommands(almalinux9, "ia32"), []);
});

test("maps NVML provider states to prerequisite outcomes", () => {
  assert.deepEqual(
    nvidiaDriverProbeOutcome(
      {
        state: "ready",
        detail: "1 NVIDIA GPU available through NVML",
        driverVersion: "595.71.05",
        deviceCount: 1,
      },
      nvidiaPci,
    ),
    {
      status: "ok",
      detail: "1 NVIDIA GPU available through NVML",
      version: "595.71.05",
      remediationAvailable: false,
    },
  );
  const missing = nvidiaDriverProbeOutcome(
    {
      state: "driver-not-loaded",
      detail: "Driver Not Loaded",
      driverVersion: null,
      deviceCount: 0,
    },
    nvidiaPci,
  );
  assert.equal(missing.status, "missing");
  assert.equal(missing.remediationAvailable, true);

  const denied = nvidiaDriverProbeOutcome(
    {
      state: "permission-denied",
      detail: "No Permission",
      driverVersion: null,
      deviceCount: 0,
    },
    nvidiaPci,
  );
  assert.equal(denied.status, "unknown");
  assert.equal(denied.remediationAvailable, false);
});

test("does not offer driver installation for a vfio-pci GPU", () => {
  const outcome = nvidiaDriverProbeOutcome(
    {
      state: "driver-not-loaded",
      detail: "Driver Not Loaded",
      driverVersion: null,
      deviceCount: 0,
    },
    {
      ...nvidiaPci,
      devices: [{ ...nvidiaPci.devices[0]!, driver: "vfio-pci" }],
    },
  );
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.remediationAvailable, false);
  assert.match(outcome.detail ?? "", /vfio-pci/);
});
