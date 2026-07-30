import type {
  EnvironmentEngine,
  EnvironmentSpec,
  SystemAccelerator,
} from "@arriero/core";
import { packageIndexInstallOptions } from "@arriero/core";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  environmentAvailability,
  type EnvironmentAvailability,
} from "./availability.js";

export type EnvironmentAvailabilityContext = {
  accelerators: SystemAccelerator[];
  installed: boolean;
  rocmDeviceAvailable: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
};

export type EnvironmentProvisioner = {
  displayName: string;
  entrypointRelative: string;
  distributions: readonly string[];
  requirements(spec: EnvironmentSpec): string[];
  installOptions(spec: EnvironmentSpec): string[];
  validationCommand(spec: EnvironmentSpec, finalDir: string): string[];
  validateLayout(spec: EnvironmentSpec, finalDir: string): string | null;
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

function vllmValidationScript(version: string) {
  return [
    "import importlib.metadata as metadata",
    "import vllm",
    `assert metadata.version('vllm') == ${JSON.stringify(version)}`,
    `assert vllm.__version__ == ${JSON.stringify(version)}`,
  ].join("; ");
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

const VLLM_PROVISIONER: EnvironmentProvisioner = {
  displayName: "vLLM",
  entrypointRelative: "bin/vllm",
  distributions: ["vllm"],
  requirements(spec) {
    if (spec.engine !== "vllm")
      throw new Error("vLLM provisioner kind mismatch");
    if (spec.source.kind === "wheel") {
      return [wheelRequirement(spec.source.url, spec.source.sha256)];
    }
    const extras = spec.source.extras.length
      ? `[${spec.source.extras.join(",")}]`
      : "";
    return [`vllm${extras}==${spec.version}`];
  },
  installOptions(spec) {
    if (spec.engine !== "vllm")
      throw new Error("vLLM provisioner kind mismatch");
    const options = packageIndexInstallOptions(spec.source);
    if (spec.source.kind === "wheel" && spec.source.torchBackend) {
      options.push("--torch-backend", spec.source.torchBackend);
    }
    return options;
  },
  validationCommand(spec, finalDir) {
    if (spec.engine !== "vllm")
      throw new Error("vLLM provisioner kind mismatch");
    return [
      resolve(finalDir, "bin", "python"),
      "-c",
      vllmValidationScript(spec.version),
    ];
  },
  validateLayout(spec, finalDir) {
    if (spec.engine !== "vllm")
      throw new Error("vLLM provisioner kind mismatch");
    return commonLayoutError({
      finalDir,
      entrypointRelative: this.entrypointRelative,
      entrypointDescription: "vLLM entrypoint",
      freezePins: [`vllm==${spec.version}`],
    });
  },
  availability(spec, context) {
    if (spec.engine !== "vllm")
      throw new Error("vLLM provisioner kind mismatch");
    return environmentAvailability({
      accelerators: context.accelerators,
      installed: context.installed,
      rocmDeviceAvailable: context.rocmDeviceAvailable,
      variant: spec.variant,
    });
  },
  catalogName(spec) {
    return `vllm ${spec.version} [${spec.id.slice(0, 8)}]`.slice(0, 80);
  },
};

const KTRANSFORMERS_PROVISIONER: EnvironmentProvisioner = {
  displayName: "KTransformers",
  entrypointRelative: "bin/sglang",
  distributions: ["kt-kernel", "sglang-kt"],
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
    const options = packageIndexInstallOptions(spec.source);
    if (spec.source.kind === "wheels" && spec.source.torchBackend) {
      options.push("--torch-backend", spec.source.torchBackend);
    }
    return options;
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
  availability(spec, context) {
    if (spec.engine !== "ktransformers") {
      throw new Error("KTransformers provisioner kind mismatch");
    }
    if (!context.installed) {
      return { availability: "not-installed", availabilityReason: null };
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
    const hasNvidia = context.accelerators.some(
      (accelerator) => accelerator.vendor === "NVIDIA",
    );
    return hasNvidia
      ? { availability: "usable", availabilityReason: null }
      : {
          availability: "unavailable",
          availabilityReason:
            "KTransformers requires an NVIDIA GPU available through NVML",
        };
  },
  catalogName(spec) {
    return `KTransformers ${spec.version} [${spec.id.slice(0, 8)}]`.slice(
      0,
      80,
    );
  },
};

const ENVIRONMENT_PROVISIONERS: Record<
  EnvironmentEngine,
  EnvironmentProvisioner
> = {
  vllm: VLLM_PROVISIONER,
  ktransformers: KTRANSFORMERS_PROVISIONER,
};

export function environmentProvisioner(
  engine: EnvironmentEngine,
): EnvironmentProvisioner {
  return ENVIRONMENT_PROVISIONERS[engine];
}
