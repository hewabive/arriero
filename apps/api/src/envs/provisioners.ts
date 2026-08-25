import {
  ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY,
  ENVIRONMENT_ENGINE_LABELS,
  type ComputeCapability,
  type EnvironmentEngine,
  type EnvironmentSpec,
  type InstanceKind,
  type SystemAccelerator,
} from "@arriero/core";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  environmentAvailability,
  type EnvironmentAvailability,
} from "./availability.js";
import {
  CHAT_UI_ENTRYPOINT_RELATIVE,
  chatUiLayoutError,
  chatUiValidationCommand,
  checkedChatUiSpec,
  writeChatUiLauncher,
} from "./chat-ui.js";

type EnvironmentAvailabilityContext = {
  accelerators: SystemAccelerator[];
  installed: boolean;
  rocmDeviceAvailable: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
};

type EnvironmentWheelArtifact = {
  url: string;
  sha256: string | null;
};

export type EnvironmentProvisioner = {
  displayName: string;
  tooling: "uv" | "node-source";
  entrypointRelative: string;
  distributions: readonly string[];
  catalogEngineKind: InstanceKind | null;
  requirements(spec: EnvironmentSpec): string[];
  installOptions(spec: EnvironmentSpec): string[];
  wheelArtifacts(spec: EnvironmentSpec): EnvironmentWheelArtifact[];
  validationCommand(spec: EnvironmentSpec, finalDir: string): string[];
  validateLayout(spec: EnvironmentSpec, finalDir: string): string | null;
  prepareFinalize(spec: EnvironmentSpec, stagingDir: string): void;
  availability(
    spec: EnvironmentSpec,
    context: EnvironmentAvailabilityContext,
  ): EnvironmentAvailability;
  catalogName(spec: EnvironmentSpec): string;
};

function wheelRequirement(url: string, sha256: string | null) {
  if (new URL(url).protocol === "file:") return fileURLToPath(url);
  return `${url}${sha256 ? `#sha256=${sha256}` : ""}`;
}

function executableError(path: string, description: string) {
  if (!existsSync(path)) return `${description} is missing: ${path}`;
  try {
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `${description} is not executable: ${path}`;
  }
}

function commonLayoutError(input: {
  finalDir: string;
  entrypointRelative: string;
  entrypointDescription: string;
  freezePins: string[];
}) {
  if (!existsSync(input.finalDir)) {
    return `environment directory is missing: ${input.finalDir}`;
  }
  const entrypoint = resolve(input.finalDir, input.entrypointRelative);
  const entrypointError = executableError(
    entrypoint,
    input.entrypointDescription,
  );
  if (entrypointError) return entrypointError;

  const python = resolve(input.finalDir, "bin", "python");
  const pythonError = executableError(python, "environment Python");
  if (pythonError) return pythonError;

  const freeze = resolve(input.finalDir, "freeze.txt");
  if (!existsSync(freeze)) {
    return `environment freeze file is missing: ${freeze}`;
  }
  const frozen = new Set(
    readFileSync(freeze, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const pin of input.freezePins) {
    if (!frozen.has(pin.toLowerCase())) {
      return `environment freeze does not contain ${pin}`;
    }
  }

  const launcher = readFileSync(entrypoint, "utf8").slice(0, 4096);
  const staging = `${input.finalDir}.staging`;
  if (launcher.includes(staging)) {
    return `${input.entrypointDescription} still references staging directory: ${staging}`;
  }
  return null;
}

function pythonPackageValidationScript(
  distribution: string,
  version: string,
  moduleVersionAttribute: boolean,
) {
  const module = distribution.replace(/-/g, "_");
  const lines = [
    "import importlib.metadata as metadata",
    `import ${module}`,
    `assert metadata.version('${distribution}') == ${JSON.stringify(version)}`,
  ];
  if (moduleVersionAttribute) {
    lines.push(`assert ${module}.__version__ == ${JSON.stringify(version)}`);
  }
  return lines.join("; ");
}

function ktransformersValidationScript(version: string) {
  return [
    "import importlib.metadata as metadata",
    "import kt_kernel",
    "import sglang",
    "from kt_kernel import kt_kernel_ext",
    "cpu_infer = kt_kernel_ext.CPUInfer(1)",
    "del cpu_infer",
    `assert metadata.version('kt-kernel') == ${JSON.stringify(version)}`,
    `assert metadata.version('sglang-kt') == ${JSON.stringify(version)}`,
  ].join("; ");
}

type SingleDistributionEngine = "vllm" | "sglang" | "open-webui";
type SingleDistributionSpec = Extract<
  EnvironmentSpec,
  { engine: SingleDistributionEngine }
>;

function singleDistributionProvisioner(options: {
  engine: SingleDistributionEngine;
  cuda: ComputeCapability | null;
  catalogEngineKind: InstanceKind | null;
  moduleVersionAttribute: boolean;
}): EnvironmentProvisioner {
  const { engine, cuda, catalogEngineKind, moduleVersionAttribute } = options;
  const displayName = ENVIRONMENT_ENGINE_LABELS[engine];
  function checkedSpec(spec: EnvironmentSpec): SingleDistributionSpec {
    if (spec.engine !== engine) {
      throw new Error(`${displayName} provisioner kind mismatch`);
    }
    return spec;
  }
  return {
    displayName,
    tooling: "uv",
    entrypointRelative: `bin/${engine}`,
    distributions: [engine],
    catalogEngineKind,
    requirements(spec) {
      const checked = checkedSpec(spec);
      if (checked.source.kind === "wheel") {
        return [wheelRequirement(checked.source.url, checked.source.sha256)];
      }
      const extras = checked.source.extras.length
        ? `[${checked.source.extras.join(",")}]`
        : "";
      return [`${engine}${extras}==${checked.version}`];
    },
    installOptions(spec) {
      const checked = checkedSpec(spec);
      return checked.source.kind === "wheel" && checked.source.torchBackend
        ? ["--torch-backend", checked.source.torchBackend]
        : [];
    },
    wheelArtifacts(spec) {
      const checked = checkedSpec(spec);
      return checked.source.kind === "wheel" ? [checked.source] : [];
    },
    validationCommand(spec, finalDir) {
      const checked = checkedSpec(spec);
      return [
        resolve(finalDir, "bin", "python"),
        "-c",
        pythonPackageValidationScript(
          engine,
          checked.version,
          moduleVersionAttribute,
        ),
      ];
    },
    validateLayout(spec, finalDir) {
      const checked = checkedSpec(spec);
      return commonLayoutError({
        finalDir,
        entrypointRelative: this.entrypointRelative,
        entrypointDescription: `${displayName} entrypoint`,
        freezePins: [`${engine}==${checked.version}`],
      });
    },
    prepareFinalize() {},
    availability(spec, context) {
      const checked = checkedSpec(spec);
      return environmentAvailability({
        accelerators: context.accelerators,
        installed: context.installed,
        rocmDeviceAvailable: context.rocmDeviceAvailable,
        variant: checked.variant,
        ...(cuda
          ? {
              cuda: {
                engineLabel: this.displayName,
                minimumComputeCapability: cuda,
              },
            }
          : {}),
      });
    },
    catalogName(spec) {
      return `${engine} ${spec.version} [${spec.id.slice(0, 8)}]`.slice(0, 80);
    },
  };
}

const VLLM_PROVISIONER = singleDistributionProvisioner({
  engine: "vllm",
  cuda: ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.vllm,
  catalogEngineKind: "vllm",
  moduleVersionAttribute: true,
});

const SGLANG_PROVISIONER = singleDistributionProvisioner({
  engine: "sglang",
  cuda: ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.sglang,
  catalogEngineKind: "sglang",
  moduleVersionAttribute: true,
});

const OPEN_WEBUI_PROVISIONER = singleDistributionProvisioner({
  engine: "open-webui",
  cuda: null,
  catalogEngineKind: null,
  moduleVersionAttribute: false,
});

const KTRANSFORMERS_PROVISIONER: EnvironmentProvisioner = {
  displayName: ENVIRONMENT_ENGINE_LABELS.ktransformers,
  tooling: "uv",
  entrypointRelative: "bin/sglang",
  distributions: ["kt-kernel", "sglang-kt"],
  catalogEngineKind: "ktransformers",
  requirements(spec) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    if (spec.source.kind === "pypi") {
      return [`kt-kernel==${spec.version}`, `sglang-kt==${spec.version}`];
    }
    const source = spec.source;
    return (["kt-kernel", "sglang-kt"] as const).map((distribution) => {
      const artifact = source.artifacts.find(
        (candidate) => candidate.distribution === distribution,
      );
      if (!artifact) throw new Error(`${distribution} wheel is missing`);
      return wheelRequirement(artifact.url, artifact.sha256);
    });
  },
  installOptions(spec) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    return spec.source.kind === "wheels" && spec.source.torchBackend
      ? ["--torch-backend", spec.source.torchBackend]
      : [];
  },
  wheelArtifacts(spec) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    return spec.source.kind === "wheels" ? spec.source.artifacts : [];
  },
  validationCommand(spec, finalDir) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    return [
      resolve(finalDir, "bin", "python"),
      "-c",
      ktransformersValidationScript(spec.version),
    ];
  },
  validateLayout(spec, finalDir) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    return commonLayoutError({
      finalDir,
      entrypointRelative: this.entrypointRelative,
      entrypointDescription: "KTransformers SGLang entrypoint",
      freezePins: [`kt-kernel==${spec.version}`, `sglang-kt==${spec.version}`],
    });
  },
  prepareFinalize() {},
  availability(spec, context) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    const platform = context.platform ?? process.platform;
    const arch = context.arch ?? process.arch;
    if (platform !== "linux" || arch !== "x64") {
      return {
        availability: "unavailable",
        availabilityReason: "KTransformers requires Linux x86-64",
      };
    }
    if (spec.pythonVersion !== "3.11" && spec.pythonVersion !== "3.12") {
      return {
        availability: "unavailable",
        availabilityReason: "KTransformers requires Python 3.11 or 3.12",
      };
    }
    return environmentAvailability({
      accelerators: context.accelerators,
      installed: context.installed,
      rocmDeviceAvailable: context.rocmDeviceAvailable,
      variant: spec.variant,
      cuda: {
        engineLabel: this.displayName,
        minimumComputeCapability:
          ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY.ktransformers,
      },
    });
  },
  catalogName(spec) {
    return `KTransformers ${spec.version} [${spec.id.slice(0, 8)}]`.slice(
      0,
      80,
    );
  },
};

const CHAT_UI_PROVISIONER: EnvironmentProvisioner = {
  displayName: ENVIRONMENT_ENGINE_LABELS["chat-ui"],
  tooling: "node-source",
  entrypointRelative: CHAT_UI_ENTRYPOINT_RELATIVE,
  distributions: [],
  catalogEngineKind: null,
  requirements() {
    return [];
  },
  installOptions() {
    return [];
  },
  wheelArtifacts() {
    return [];
  },
  validationCommand(spec, finalDir) {
    return chatUiValidationCommand(checkedChatUiSpec(spec), finalDir);
  },
  validateLayout(spec, finalDir) {
    checkedChatUiSpec(spec);
    return chatUiLayoutError(finalDir);
  },
  prepareFinalize(spec, stagingDir) {
    checkedChatUiSpec(spec);
    writeChatUiLauncher(stagingDir);
  },
  availability(spec, context) {
    const checked = checkedChatUiSpec(spec);
    return environmentAvailability({
      accelerators: context.accelerators,
      installed: context.installed,
      rocmDeviceAvailable: context.rocmDeviceAvailable,
      variant: checked.variant,
    });
  },
  catalogName(spec) {
    return `chat-ui ${spec.version} [${spec.id.slice(0, 8)}]`.slice(0, 80);
  },
};

const ENVIRONMENT_PROVISIONERS: Record<
  EnvironmentEngine,
  EnvironmentProvisioner
> = {
  vllm: VLLM_PROVISIONER,
  sglang: SGLANG_PROVISIONER,
  ktransformers: KTRANSFORMERS_PROVISIONER,
  "open-webui": OPEN_WEBUI_PROVISIONER,
  "chat-ui": CHAT_UI_PROVISIONER,
};

export function environmentProvisioner(
  engine: EnvironmentEngine,
): EnvironmentProvisioner {
  return ENVIRONMENT_PROVISIONERS[engine];
}
