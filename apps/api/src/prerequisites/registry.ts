import {
  ENVIRONMENT_UV_MIN_VERSION,
  type HostPackageManager,
  type PrerequisiteCheckKind,
  type PrerequisiteSeverity,
  type PrerequisiteStatus,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { isSupportedUvVersionOutput } from "../envs/uv.js";
import { detectNumaBind } from "../numa/capability.js";
import type { OsRelease } from "../system/os-release.js";
import { packageManagerForOsRelease } from "../system/os-release.js";
import {
  findHeader,
  findExecutableInPath,
  probeAnyExecutable,
  probePkgConfigModule,
} from "../system/tool-probe.js";
import {
  type DisplayPciInventory,
  displayPciInventoryUsesVfio,
} from "../system/pci-inventory.js";
import type { NvidiaTelemetryStatus } from "../nvidia/telemetry.js";
import { probeOpensslDevelopmentFiles } from "./openssl.js";

export type PrerequisiteUsage = {
  cudaBuild: boolean;
  httpsFeatures: boolean;
  numaBind: boolean;
  numaInterleave: boolean;
  pythonEngines: boolean;
};

export type PrerequisiteProbeContext = {
  env: NodeJS.ProcessEnv;
  searchDirectories: string[];
  usage: PrerequisiteUsage;
  nvidiaPci: DisplayPciInventory;
  amdPci: DisplayPciInventory;
  rocmDeviceAvailable: boolean;
  nvidiaTelemetryStatus: () => NvidiaTelemetryStatus;
};

export type PrerequisiteProbeOutcome = {
  status: PrerequisiteStatus;
  detail: string | null;
  version: string | null;
  remediationAvailable?: boolean;
};

type PrerequisiteCommandSource = string[] | ((release: OsRelease) => string[]);

export type PrerequisiteDefinition = {
  id: string;
  group: string;
  title: string;
  kind: PrerequisiteCheckKind;
  severity:
    | PrerequisiteSeverity
    | ((usage: PrerequisiteUsage) => PrerequisiteSeverity);
  blocks: string[];
  impact: string;
  packages: Partial<Record<HostPackageManager, string[]>>;
  commands: PrerequisiteCommandSource;
  installCommands?: PrerequisiteCommandSource;
  includeInInstallPlan?: boolean;
  requiresRebootAfterInstall?: boolean;
  applies?: (context: PrerequisiteProbeContext) => boolean;
  docPath: string | null;
  note: string | null;
  probe: (
    context: PrerequisiteProbeContext,
  ) => Promise<PrerequisiteProbeOutcome>;
};

export type PrerequisiteGroupDefinition = {
  id: string;
  title: string;
  description: string;
};

export const prerequisiteGroups: PrerequisiteGroupDefinition[] = [
  {
    id: "build",
    title: "llama.cpp source builds",
    description:
      "Toolchain used by the Build page to configure and compile llama-server from source",
  },
  {
    id: "cuda",
    title: "NVIDIA GPU offload",
    description:
      "CUDA toolkit and NVIDIA driver support for GPU builds and accelerator telemetry",
  },
  {
    id: "numa",
    title: "NUMA placement",
    description:
      "Host support for pinning and interleaving instance memory across NUMA nodes",
  },
  {
    id: "python-engines",
    title: "Python inference engines",
    description:
      "Tooling for uv-managed environments (vLLM, KTransformers) and their accelerators",
  },
];

function executableProbe(
  names: string[],
  versionArgs: string[] | null = ["--version"],
) {
  return async (
    context: PrerequisiteProbeContext,
  ): Promise<PrerequisiteProbeOutcome> => {
    const probe = await probeAnyExecutable(names, {
      env: context.env,
      extraDirectories: context.searchDirectories,
      versionArgs,
    });
    if (!probe.found) {
      return { status: "missing", detail: null, version: null };
    }
    return {
      status: probe.inPath ? "ok" : "out-of-path",
      detail: probe.found,
      version: probe.version,
    };
  };
}

function devicePresenceProbe(path: string) {
  return async (): Promise<PrerequisiteProbeOutcome> => ({
    status: existsSync(path) ? "ok" : "missing",
    detail: path,
    version: null,
  });
}

const NVIDIA_RHEL_FAMILY_IDS = new Set(["rhel", "rocky", "almalinux", "ol"]);

function nvidiaCudaRepoCommands(
  release: OsRelease,
  architecture: NodeJS.Architecture,
): string[] {
  if (architecture !== "x64") {
    return [];
  }

  const majorVersion = release.versionId?.split(".")[0];
  if (!majorVersion || !/^\d+$/.test(majorVersion)) {
    return [];
  }

  const fedora = release.id === "fedora";
  if (!fedora && !NVIDIA_RHEL_FAMILY_IDS.has(release.id ?? "")) {
    return [];
  }

  const repository = fedora ? `fedora${majorVersion}` : `rhel${majorVersion}`;
  const repositoryUrl =
    `https://developer.download.nvidia.com/compute/cuda/repos/${repository}` +
    `/x86_64/cuda-${repository}.repo`;
  return [
    fedora
      ? `sudo dnf config-manager addrepo --from-repofile=${repositoryUrl}`
      : `sudo dnf config-manager --add-repo ${repositoryUrl}`,
    "sudo dnf clean expire-cache",
  ];
}

export function nvidiaDriverInstallCommands(
  release: OsRelease,
  architecture: NodeJS.Architecture = process.arch,
): string[] {
  const family = new Set(
    [release.id, ...release.idLike].filter(
      (item): item is string => item !== null,
    ),
  );
  if (family.has("ubuntu")) {
    return [
      ...ubuntuNvidiaUtilsPackageCommands(),
      "sudo ubuntu-drivers install --gpgpu",
      'sudo apt-get install -y "$nvidia_utils_package"',
    ];
  }

  if (release.id !== "rocky" || release.versionId?.split(".")[0] !== "9") {
    return [];
  }
  const repoCommands = nvidiaCudaRepoCommands(release, architecture);
  if (repoCommands.length === 0) {
    return [];
  }

  return [
    "sudo dnf config-manager --set-enabled crb",
    "sudo dnf install -y epel-release kernel-devel-matched kernel-headers",
    ...repoCommands,
    "sudo dnf install -y nvidia-driver-assistant",
    "nvidia-driver-assistant --install",
    "sudo dnf install -y nvidia-driver-cuda",
  ];
}

function ubuntuNvidiaUtilsPackageCommands(): string[] {
  return [
    "nvidia_utils_package=\"$(ubuntu-drivers list --gpgpu --recommended | sed -nE 's/^nvidia-driver-([0-9]+(-server)?)(-open)?([[:space:]].*)?$/nvidia-utils-\\1/p' | head -n 1)\"",
    'test -n "$nvidia_utils_package"',
  ];
}

export function nvidiaSmiInstallCommands(
  release: OsRelease,
  architecture: NodeJS.Architecture = process.arch,
): string[] {
  const family = new Set(
    [release.id, ...release.idLike].filter(
      (item): item is string => item !== null,
    ),
  );
  if (family.has("ubuntu")) {
    return [
      ...ubuntuNvidiaUtilsPackageCommands(),
      'sudo apt-get install -y "$nvidia_utils_package"',
    ];
  }
  if (
    architecture === "x64" &&
    release.id === "rocky" &&
    release.versionId?.split(".")[0] === "9"
  ) {
    return ["sudo dnf install -y nvidia-driver-cuda"];
  }
  return [];
}

export function nvidiaDriverManualCommands(
  release: OsRelease,
  architecture: NodeJS.Architecture = process.arch,
): string[] {
  return nvidiaDriverInstallCommands(release, architecture).length > 0
    ? ["sudo reboot"]
    : [];
}

export function cudaToolkitInstallCommands(
  release: OsRelease,
  architecture: NodeJS.Architecture = process.arch,
): string[] {
  const repoCommands = nvidiaCudaRepoCommands(release, architecture);
  return repoCommands.length > 0
    ? [...repoCommands, "sudo dnf install -y cuda-toolkit"]
    : [];
}

export function nvidiaDriverProbeOutcome(
  status: NvidiaTelemetryStatus,
  pci: DisplayPciInventory,
): PrerequisiteProbeOutcome {
  if (status.state === "ready") {
    return {
      status: "ok",
      detail: status.detail,
      version: status.driverVersion,
      remediationAvailable: false,
    };
  }
  if (pci.state !== "present") {
    return {
      status: "unknown",
      detail: `${pci.detail}. ${status.detail ?? "NVML is unavailable"}`,
      version: status.driverVersion,
      remediationAvailable: false,
    };
  }
  if (displayPciInventoryUsesVfio(pci)) {
    return {
      status: "unknown",
      detail: `${pci.detail}. At least one NVIDIA GPU is bound to vfio-pci and may be intentionally reserved for passthrough; automatic driver installation is disabled.`,
      version: status.driverVersion,
      remediationAvailable: false,
    };
  }

  const installable =
    status.state === "no-library" || status.state === "driver-not-loaded";
  return {
    status: installable ? "missing" : "unknown",
    detail: `${pci.detail}. ${status.detail ?? "NVML did not expose the detected GPU"}`,
    version: status.driverVersion,
    remediationAvailable: installable,
  };
}

function nvidiaDriverIsApplicable(context: PrerequisiteProbeContext): boolean {
  return (
    context.nvidiaPci.state === "present" ||
    context.nvidiaTelemetryStatus().state === "ready"
  );
}

function nvidiaCudaIsApplicable(context: PrerequisiteProbeContext): boolean {
  return context.usage.cudaBuild || nvidiaDriverIsApplicable(context);
}

function nvidiaSmiIsApplicable(context: PrerequisiteProbeContext): boolean {
  return context.nvidiaTelemetryStatus().state === "ready";
}

function rocmKfdIsApplicable(context: PrerequisiteProbeContext): boolean {
  return context.amdPci.state === "present" || context.rocmDeviceAvailable;
}

const UV_PIPX_INSTALL_COMMAND = `pipx install --force uv==${ENVIRONMENT_UV_MIN_VERSION}`;
const UV_STANDALONE_INSTALL_COMMAND = `curl -LsSf https://astral.sh/uv/${ENVIRONMENT_UV_MIN_VERSION}/install.sh | env UV_NO_MODIFY_PATH=1 sh`;

export function uvInstallCommands(
  release: OsRelease,
  pipxAvailable: boolean,
): string[] {
  const packageManager = packageManagerForOsRelease(release);
  if (pipxAvailable) {
    return [UV_PIPX_INSTALL_COMMAND];
  }
  if (packageManager === "apt") {
    return ["sudo apt install -y pipx", UV_PIPX_INSTALL_COMMAND];
  }
  if (release.id === "fedora") {
    return ["sudo dnf install -y pipx", UV_PIPX_INSTALL_COMMAND];
  }
  if (packageManager === "pacman") {
    return ["sudo pacman -S --needed python-pipx", UV_PIPX_INSTALL_COMMAND];
  }
  if (packageManager === "apk") {
    return ["sudo apk add pipx", UV_PIPX_INSTALL_COMMAND];
  }
  return [UV_STANDALONE_INSTALL_COMMAND];
}

async function uvPrerequisiteProbe(
  context: PrerequisiteProbeContext,
): Promise<PrerequisiteProbeOutcome> {
  const probe = await probeAnyExecutable(["uv"], {
    env: context.env,
    extraDirectories: context.searchDirectories,
    versionArgs: ["--version"],
  });
  if (!probe.found) {
    return { status: "missing", detail: null, version: null };
  }
  if (!probe.version || !isSupportedUvVersionOutput(probe.version)) {
    return {
      status: "missing",
      detail: `${probe.found}; Python environments require uv >=${ENVIRONMENT_UV_MIN_VERSION}`,
      version: probe.version,
    };
  }
  return {
    status: probe.inPath ? "ok" : "out-of-path",
    detail: probe.found,
    version: probe.version,
  };
}

export const prerequisiteDefinitions: PrerequisiteDefinition[] = [
  {
    id: "cmake",
    group: "build",
    title: "CMake",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp build"],
    impact:
      "The configure step spawns cmake directly; without it the build fails with spawn cmake ENOENT after the source checkout and UI build have already run.",
    packages: {
      apt: ["cmake"],
      dnf: ["cmake"],
      pacman: ["cmake"],
      zypper: ["cmake"],
      apk: ["cmake"],
    },
    commands: [],
    docPath: null,
    note: null,
    probe: executableProbe(["cmake"]),
  },
  {
    id: "cxx-toolchain",
    group: "build",
    title: "C/C++ compiler",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp build"],
    impact:
      "CMake aborts during configure when no working C and C++ compiler is found.",
    packages: {
      apt: ["build-essential"],
      dnf: ["gcc", "gcc-c++", "make"],
      pacman: ["base-devel"],
      zypper: ["gcc", "gcc-c++", "make"],
      apk: ["build-base"],
    },
    commands: [],
    docPath: null,
    note: "Detection looks for c++, g++ or clang++; the package also provides the matching C compiler.",
    probe: executableProbe(["c++", "g++", "clang++"]),
  },
  {
    id: "make",
    group: "build",
    title: "GNU Make",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp build"],
    impact:
      "CMake generates Unix Makefiles by default on Linux, so the build step needs make unless another generator is configured explicitly.",
    packages: {
      apt: ["build-essential"],
      dnf: ["make"],
      pacman: ["base-devel"],
      zypper: ["make"],
      apk: ["build-base"],
    },
    commands: [],
    docPath: null,
    note: null,
    probe: executableProbe(["make"]),
  },
  {
    id: "pkg-config",
    group: "build",
    title: "pkg-config",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp build"],
    impact:
      "CMake locates libcurl and other system libraries through pkg-config; without it those lookups fail even when the libraries are installed.",
    packages: {
      apt: ["pkg-config"],
      dnf: ["pkgconf-pkg-config"],
      pacman: ["pkgconf"],
      zypper: ["pkg-config"],
      apk: ["pkgconf"],
    },
    commands: [],
    docPath: null,
    note: null,
    probe: executableProbe(["pkg-config"]),
  },
  {
    id: "libcurl-dev",
    group: "build",
    title: "libcurl development files",
    kind: "pkg-config",
    severity: "recommended",
    blocks: ["llama.cpp build"],
    impact:
      "Downloads moved from libcurl to the vendored cpp-httplib, so current refs configure without it; only building a ref from before that migration still fails at configure time when the headers are absent.",
    packages: {
      apt: ["libcurl4-openssl-dev"],
      dnf: ["libcurl-devel"],
      pacman: ["curl"],
      zypper: ["libcurl-devel"],
      apk: ["curl-dev"],
    },
    commands: [],
    docPath: null,
    note: "LLAMA_CURL is a deprecated no-op on current master; keep the headers only to stay able to build older refs.",
    probe: async (context) => {
      const probe = await probePkgConfigModule("libcurl", context.env);
      if (probe.found) {
        return { status: "ok", detail: "libcurl", version: probe.version };
      }
      const header = findHeader("curl/curl.h");
      return header
        ? { status: "ok", detail: header, version: null }
        : { status: "missing", detail: null, version: null };
    },
  },
  {
    id: "openssl-dev",
    group: "build",
    title: "OpenSSL development files",
    kind: "pkg-config",
    severity: (usage) => (usage.httpsFeatures ? "required" : "recommended"),
    blocks: ["HuggingFace model downloads", "llama-server TLS"],
    impact:
      "The vendored cpp-httplib only speaks HTTPS when OpenSSL headers were present at configure time. Absence never fails the build — CMake merely warns and produces a binary without TLS — so -hf, --model-url and --docker-repo fail at instance startup instead, and --ssl-key-file silently serves plaintext.",
    packages: {
      apt: ["libssl-dev"],
      dnf: ["openssl-devel"],
      pacman: ["openssl"],
      zypper: ["libopenssl-devel"],
      apk: ["openssl-dev"],
    },
    commands: [],
    docPath: null,
    note: "Compiled into llama-server, so installing it takes effect only after a rebuild. OpenSSL 3.0 or newer is required.",
    probe: (context) => probeOpensslDevelopmentFiles(context.env),
  },
  {
    id: "git",
    group: "build",
    title: "Git",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp build", "source repositories", "configuration Git"],
    impact:
      "Source checkouts, ref switching, pulls and the configuration repository all shell out to git.",
    packages: {
      apt: ["git"],
      dnf: ["git"],
      pacman: ["git"],
      zypper: ["git"],
      apk: ["git"],
    },
    commands: [],
    docPath: "docs/SOURCE_REPOSITORIES.md",
    note: null,
    probe: executableProbe(["git"]),
  },
  {
    id: "node",
    group: "build",
    title: "Node.js",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp web UI build"],
    impact:
      "The ui-install step runs npm inside tools/ui; a Node.js installed only through nvm is usually missing from the PATH of a systemd --user service.",
    packages: {
      apt: ["nodejs"],
      dnf: ["nodejs"],
      pacman: ["nodejs"],
      zypper: ["nodejs"],
      apk: ["nodejs"],
    },
    commands: [],
    docPath: null,
    note: "Disable the UI rebuild on the Build page to skip this dependency.",
    probe: executableProbe(["node"]),
  },
  {
    id: "npm",
    group: "build",
    title: "npm",
    kind: "executable",
    severity: "required",
    blocks: ["llama.cpp web UI build"],
    impact:
      "The ui-install step runs npm ci followed by npm run build in tools/ui.",
    packages: {
      apt: ["npm"],
      dnf: ["npm"],
      pacman: ["npm"],
      zypper: ["npm"],
      apk: ["npm"],
    },
    commands: [],
    docPath: null,
    note: "Disable the UI rebuild on the Build page to skip this dependency.",
    probe: executableProbe(["npm"]),
  },
  {
    id: "ccache",
    group: "build",
    title: "ccache",
    kind: "executable",
    severity: "recommended",
    blocks: [],
    impact:
      "llama.cpp enables ccache when it is present, which turns repeated rebuilds of the same ref from minutes into seconds.",
    packages: {
      apt: ["ccache"],
      dnf: ["ccache"],
      pacman: ["ccache"],
      zypper: ["ccache"],
      apk: ["ccache"],
    },
    commands: [],
    docPath: null,
    note: null,
    probe: executableProbe(["ccache"]),
  },
  {
    id: "ninja",
    group: "build",
    title: "Ninja",
    kind: "executable",
    severity: "recommended",
    blocks: [],
    impact:
      "An alternative generator that parallelises the build better than Make; select it with -G Ninja in extra CMake arguments.",
    packages: {
      apt: ["ninja-build"],
      dnf: ["ninja-build"],
      pacman: ["ninja"],
      zypper: ["ninja"],
      apk: ["samurai"],
    },
    commands: [],
    docPath: null,
    note: null,
    probe: executableProbe(["ninja"]),
  },
  {
    id: "nvcc",
    group: "cuda",
    title: "CUDA compiler (nvcc)",
    kind: "executable",
    severity: (usage) => (usage.cudaBuild ? "required" : "recommended"),
    blocks: ["CUDA build"],
    impact:
      "GGML_CUDA=ON builds need nvcc. The build environment auto-prepends its directory to PATH once nvcc is found on disk, so an out-of-path toolkit still works for builds.",
    packages: {
      apt: ["nvidia-cuda-toolkit"],
      pacman: ["cuda"],
      zypper: ["cuda-toolkit"],
    },
    commands: [],
    installCommands: cudaToolkitInstallCommands,
    applies: nvidiaCudaIsApplicable,
    docPath: null,
    note: "DNF systems need NVIDIA's distribution-specific CUDA repository before the cuda-toolkit package is available. Also detected through CUDACXX, CUDA_HOME, CUDA_PATH, /usr/local/cuda and /opt/cuda.",
    probe: executableProbe(["nvcc"], ["--version"]),
  },
  {
    id: "nvidia-driver",
    group: "cuda",
    title: "NVIDIA driver (NVML)",
    kind: "capability",
    severity: "required",
    blocks: ["NVIDIA GPU use"],
    impact:
      "GPU detection, VRAM pool capacity and per-process GPU memory telemetry use the resident NVML provider; without a usable NVIDIA driver GPU memory pools must be sized by hand.",
    packages: {},
    commands: nvidiaDriverManualCommands,
    installCommands: nvidiaDriverInstallCommands,
    includeInInstallPlan: false,
    requiresRebootAfterInstall: true,
    applies: nvidiaDriverIsApplicable,
    docPath: "docs/RESOURCE_MANAGEMENT.md",
    note: "NVML ships with the NVIDIA driver, not with the CUDA toolkit. The distro-specific helper selects a driver compatible with the detected PCI GPU: ubuntu-drivers on Ubuntu, or NVIDIA's driver assistant on Rocky Linux 9 x86-64. The install also adds nvidia-smi for operator diagnostics. Reboot remains a separate manual action; after the server returns, press Re-check.",
    probe: async (context) =>
      nvidiaDriverProbeOutcome(
        context.nvidiaTelemetryStatus(),
        context.nvidiaPci,
      ),
  },
  {
    id: "nvidia-smi",
    group: "cuda",
    title: "NVIDIA diagnostics (nvidia-smi)",
    kind: "executable",
    severity: "recommended",
    blocks: [],
    impact:
      "nvidia-smi is useful for inspecting driver state, utilization, temperatures and per-process GPU memory from the host shell.",
    packages: {},
    commands: [],
    installCommands: nvidiaSmiInstallCommands,
    includeInInstallPlan: false,
    applies: nvidiaSmiIsApplicable,
    docPath: null,
    note: "Arriero telemetry uses NVML directly and does not depend on this CLI. The installer adds the utility package matching the Ubuntu driver branch, or NVIDIA's compute userspace package on Rocky Linux 9.",
    probe: executableProbe(["nvidia-smi"]),
  },
  {
    id: "numactl",
    group: "numa",
    title: "numactl",
    kind: "executable",
    severity: (usage) => (usage.numaInterleave ? "required" : "recommended"),
    blocks: ["NUMA interleave mode"],
    impact:
      "Interleave placement wraps the spawn in numactl --interleave; instances configured for interleave cannot start without it.",
    packages: {
      apt: ["numactl"],
      dnf: ["numactl"],
      pacman: ["numactl"],
      zypper: ["numactl"],
    },
    commands: [],
    docPath: "docs/NUMA_PINNING.md",
    note: null,
    probe: executableProbe(["numactl"], ["--show"]),
  },
  {
    id: "cpuset-delegation",
    group: "numa",
    title: "cpuset cgroup delegation",
    kind: "capability",
    severity: (usage) => (usage.numaBind ? "required" : "recommended"),
    blocks: ["NUMA bind mode"],
    impact:
      "Bind placement creates a cpuset cgroup under the delegated user@<uid>.service root; without the Delegate=cpuset drop-in that directory is not writable and bind instances cannot start.",
    packages: {},
    commands: ["scripts/setup-numa-cgroup-delegation.sh"],
    docPath: "docs/NUMA_PINNING.md",
    note: "One-time setup; the manager must then run inside that user session.",
    probe: async () => ({
      status: detectNumaBind() ? "ok" : "missing",
      detail: "/sys/fs/cgroup delegated cpuset controller",
      version: null,
    }),
  },
  {
    id: "uv",
    group: "python-engines",
    title: "uv",
    kind: "executable",
    severity: (usage) => (usage.pythonEngines ? "required" : "recommended"),
    blocks: ["Python environments"],
    impact:
      "uv is the only supported provisioner for Python inference engines; it also pins the interpreter, so there is no system-python fallback.",
    packages: {},
    commands: [],
    installCommands: (release) =>
      uvInstallCommands(
        release,
        findExecutableInPath("pipx", process.env.PATH) !== null,
      ),
    docPath: "docs/ENVIRONMENTS.md",
    note: `Python environments require uv >=${ENVIRONMENT_UV_MIN_VERSION}; the configured Python mirror must cover the installed consumer uv version. User-scoped installers expose uv in ~/.local/bin; Re-check adds that directory to the manager PATH automatically.`,
    probe: uvPrerequisiteProbe,
  },
  {
    id: "rocm-kfd",
    group: "python-engines",
    title: "ROCm kernel driver (/dev/kfd)",
    kind: "device",
    severity: "recommended",
    blocks: ["ROCm environments"],
    impact:
      "ROCm environment variants require an accessible /dev/kfd device; without it they are reported as unavailable.",
    packages: {},
    commands: [],
    applies: rocmKfdIsApplicable,
    docPath: "docs/ENVIRONMENTS.md",
    note: "Needs the amdgpu/ROCm kernel driver and membership in the render/video group.",
    probe: devicePresenceProbe("/dev/kfd"),
  },
];

export function resolveSeverity(
  definition: PrerequisiteDefinition,
  usage: PrerequisiteUsage,
): PrerequisiteSeverity {
  return typeof definition.severity === "function"
    ? definition.severity(usage)
    : definition.severity;
}

export function findPrerequisiteDefinition(id: string) {
  return prerequisiteDefinitions.find((item) => item.id === id) ?? null;
}
