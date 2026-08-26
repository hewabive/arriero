import {
  ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY,
  ENVIRONMENT_ENGINE_LABELS,
  packageIndexInstallOptions,
  type ComputeCapability,
  type EnvironmentEngine,
  type EnvironmentJobStep,
  type EnvironmentRepositorySettings,
  type EnvironmentSpec,
  type InstanceKind,
  type SystemAccelerator,
} from "@arriero/core";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandLog } from "../jobs/exec.js";
import { getPackageRegistriesSettings } from "../settings/registries.js";
import { executableError } from "../utils/executable.js";
import {
  environmentAvailability,
  type EnvironmentAvailability,
} from "./availability.js";
import {
  CHAT_UI_ENTRYPOINT_RELATIVE,
  chatUiJobSteps,
  chatUiLayoutError,
  chatUiValidationCommand,
  checkedChatUiSpec,
  patchChatUiManifest,
  writeChatUiLauncher,
} from "./chat-ui.js";
import type { NodeSourceTools } from "./node-tools.js";
import { pendingJobStep } from "./steps.js";

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

export type EnvironmentTooling =
  | { kind: "uv"; uv: string }
  | ({ kind: "node-source" } & NodeSourceTools);

type EnvironmentJobDirectories = { staging: string; final: string };

type EnvironmentInProcessStepContext = {
  spec: EnvironmentSpec;
  stagingDir: string;
  log: CommandLog;
};

export type EnvironmentProvisioner = {
  displayName: string;
  entrypointRelative: string;
  distributions: readonly string[];
  catalogEngineKind: InstanceKind | null;
  requirements(spec: EnvironmentSpec): string[];
  installOptions(spec: EnvironmentSpec): string[];
  wheelArtifacts(spec: EnvironmentSpec): EnvironmentWheelArtifact[];
  jobSteps(
    spec: EnvironmentSpec,
    tools: EnvironmentTooling,
    directories: EnvironmentJobDirectories,
    repositories: EnvironmentRepositorySettings,
  ): EnvironmentJobStep[];
  inProcessSteps: Partial<
    Record<
      EnvironmentJobStep["name"],
      (context: EnvironmentInProcessStepContext) => Promise<void> | void
    >
  >;
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

function localWheelArtifacts(
  provisioner: EnvironmentProvisioner,
  spec: EnvironmentSpec,
) {
  return provisioner.wheelArtifacts(spec).flatMap((artifact) => {
    if (!artifact.sha256 || new URL(artifact.url).protocol !== "file:") {
      return [];
    }
    return [
      {
        path: fileURLToPath(artifact.url),
        sha256: artifact.sha256.toLowerCase(),
      },
    ];
  });
}

function sha256File(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function verifyLocalWheelArtifacts(
  provisioner: EnvironmentProvisioner,
  spec: EnvironmentSpec,
  log: CommandLog,
) {
  for (const artifact of localWheelArtifacts(provisioner, spec)) {
    const actual = await sha256File(artifact.path);
    if (actual !== artifact.sha256) {
      throw new Error(
        `wheel SHA-256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    log.write(`# verified SHA-256 ${actual}  ${artifact.path}\n`);
  }
}

function checkedUvSpec(spec: EnvironmentSpec) {
  if (spec.engine === "chat-ui") {
    throw new Error("Chat UI environments install with git and npm");
  }
  return spec;
}

function uvJobSteps(
  provisioner: EnvironmentProvisioner,
  spec: EnvironmentSpec,
  tools: EnvironmentTooling,
  directories: EnvironmentJobDirectories,
  repositories: EnvironmentRepositorySettings,
): EnvironmentJobStep[] {
  if (tools.kind !== "uv") {
    throw new Error(`${spec.engine} environments install with uv`);
  }
  const pythonVersion = checkedUvSpec(spec).pythonVersion;
  const uv = tools.uv;
  const { staging, final } = directories;
  const python = resolve(staging, "bin", "python");
  const install = [
    uv,
    "pip",
    "install",
    "--no-config",
    "--python",
    python,
    ...provisioner.requirements(spec),
    ...packageIndexInstallOptions(repositories.packageIndexUrl),
    ...provisioner.installOptions(spec),
  ];
  return [
    pendingJobStep(
      "python-install",
      repositories.pythonMirrorUrl
        ? [
            uv,
            "python",
            "install",
            "--no-config",
            "--mirror",
            repositories.pythonMirrorUrl,
            pythonVersion,
          ]
        : [uv, "python", "install", "--no-config", pythonVersion],
    ),
    pendingJobStep("venv-create", [
      uv,
      "venv",
      "--no-config",
      "--relocatable",
      "--managed-python",
      "--no-python-downloads",
      "--python",
      pythonVersion,
      staging,
    ]),
    ...(localWheelArtifacts(provisioner, spec).length
      ? [pendingJobStep("artifact-verify", ["verify-local-wheel-sha256"])]
      : []),
    pendingJobStep("package-install", install),
    pendingJobStep("freeze", [
      uv,
      "pip",
      "list",
      "--no-config",
      "--format",
      "freeze",
      "--python",
      python,
    ]),
    pendingJobStep("finalize", ["finalize-environment", staging, final]),
    pendingJobStep("validate", provisioner.validationCommand(spec, final)),
  ];
}

const UV_IN_PROCESS_STEPS: EnvironmentProvisioner["inProcessSteps"] = {
  "artifact-verify": ({ spec, log }) =>
    verifyLocalWheelArtifacts(environmentProvisioner(spec.engine), spec, log),
};

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
    entrypointRelative: `bin/${engine}`,
    distributions: [engine],
    catalogEngineKind,
    jobSteps(spec, tools, directories, repositories) {
      return uvJobSteps(this, spec, tools, directories, repositories);
    },
    inProcessSteps: UV_IN_PROCESS_STEPS,
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

type KtransformersSpec = Extract<EnvironmentSpec, { engine: "ktransformers" }>;

function checkedKtransformersSpec(spec: EnvironmentSpec): KtransformersSpec {
  if (spec.engine !== "ktransformers") {
    throw new Error("KTransformers provisioner kind mismatch");
  }
  return spec;
}

const KTRANSFORMERS_PROVISIONER: EnvironmentProvisioner = {
  displayName: ENVIRONMENT_ENGINE_LABELS.ktransformers,
  entrypointRelative: "bin/sglang",
  distributions: ["kt-kernel", "sglang-kt"],
  catalogEngineKind: "ktransformers",
  jobSteps(spec, tools, directories, repositories) {
    return uvJobSteps(this, spec, tools, directories, repositories);
  },
  inProcessSteps: UV_IN_PROCESS_STEPS,
  requirements(spec) {
    const checked = checkedKtransformersSpec(spec);
    if (checked.source.kind === "pypi") {
      return [`kt-kernel==${checked.version}`, `sglang-kt==${checked.version}`];
    }
    const source = checked.source;
    return (["kt-kernel", "sglang-kt"] as const).map((distribution) => {
      const artifact = source.artifacts.find(
        (candidate) => candidate.distribution === distribution,
      );
      if (!artifact) throw new Error(`${distribution} wheel is missing`);
      return wheelRequirement(artifact.url, artifact.sha256);
    });
  },
  installOptions(spec) {
    const checked = checkedKtransformersSpec(spec);
    return checked.source.kind === "wheels" && checked.source.torchBackend
      ? ["--torch-backend", checked.source.torchBackend]
      : [];
  },
  wheelArtifacts(spec) {
    const checked = checkedKtransformersSpec(spec);
    return checked.source.kind === "wheels" ? checked.source.artifacts : [];
  },
  validationCommand(spec, finalDir) {
    const checked = checkedKtransformersSpec(spec);
    return [
      resolve(finalDir, "bin", "python"),
      "-c",
      ktransformersValidationScript(checked.version),
    ];
  },
  validateLayout(spec, finalDir) {
    const checked = checkedKtransformersSpec(spec);
    return commonLayoutError({
      finalDir,
      entrypointRelative: this.entrypointRelative,
      entrypointDescription: "KTransformers SGLang entrypoint",
      freezePins: [
        `kt-kernel==${checked.version}`,
        `sglang-kt==${checked.version}`,
      ],
    });
  },
  prepareFinalize() {},
  availability(spec, context) {
    const checked = checkedKtransformersSpec(spec);
    const platform = context.platform ?? process.platform;
    const arch = context.arch ?? process.arch;
    if (platform !== "linux" || arch !== "x64") {
      return {
        availability: "unavailable",
        availabilityReason: "KTransformers requires Linux x86-64",
      };
    }
    if (checked.pythonVersion !== "3.11" && checked.pythonVersion !== "3.12") {
      return {
        availability: "unavailable",
        availabilityReason: "KTransformers requires Python 3.11 or 3.12",
      };
    }
    return environmentAvailability({
      accelerators: context.accelerators,
      installed: context.installed,
      rocmDeviceAvailable: context.rocmDeviceAvailable,
      variant: checked.variant,
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
  jobSteps(spec, tools, directories) {
    if (tools.kind !== "node-source") {
      throw new Error("Chat UI environments install with git and npm");
    }
    return chatUiJobSteps(
      checkedChatUiSpec(spec),
      tools,
      directories,
      getPackageRegistriesSettings().npmRegistryUrl,
    );
  },
  inProcessSteps: {
    "manifest-patch": ({ stagingDir, log }) => {
      patchChatUiManifest(stagingDir, log);
    },
  },
  validationCommand(spec, finalDir) {
    checkedChatUiSpec(spec);
    return chatUiValidationCommand(finalDir);
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
