import {
  ENVIRONMENT_DEFAULT_PYTHON_VERSION,
  ENVIRONMENT_ENGINE_LABELS,
  ENVIRONMENT_VARIANTS,
  environmentInstallChannel,
  KTRANSFORMERS_PYTHON_VERSIONS,
  OPEN_WEBUI_PYTHON_VERSIONS,
  SGLANG_DEFAULT_EXTRAS,
  type EnvironmentEngine,
  type EnvironmentInstallChannel,
  type EnvironmentVariant,
} from "./environments.js";
import type { InstanceKind } from "./engine-descriptor.js";

export const ENVIRONMENT_VARIANT_LABELS: Record<EnvironmentVariant, string> = {
  cuda: "CUDA",
  cpu: "CPU",
  rocm: "ROCm",
};

export type EnvironmentPythonRuntime = {
  versions: readonly string[] | null;
  defaultVersion: string;
};

export type EnvironmentCreateFacts = {
  label: string;
  versionPlaceholder: string;
  note: string | null;
};

export type EnvironmentDescriptor = {
  id: EnvironmentEngine;
  displayName: string;
  installChannel: EnvironmentInstallChannel;
  instanceKind: InstanceKind | null;
  variants: readonly EnvironmentVariant[];
  python: EnvironmentPythonRuntime | null;
  distributions: readonly string[];
  defaultExtras: readonly string[];
  create: EnvironmentCreateFacts | null;
};

function descriptorIdentity(id: EnvironmentEngine) {
  return {
    id,
    displayName: ENVIRONMENT_ENGINE_LABELS[id],
    installChannel: environmentInstallChannel(id),
  };
}

const ENVIRONMENT_DESCRIPTORS: Record<
  EnvironmentEngine,
  EnvironmentDescriptor
> = {
  vllm: {
    ...descriptorIdentity("vllm"),
    instanceKind: "vllm",
    variants: ENVIRONMENT_VARIANTS,
    python: {
      versions: null,
      defaultVersion: ENVIRONMENT_DEFAULT_PYTHON_VERSION,
    },
    distributions: ["vllm"],
    defaultExtras: [],
    create: {
      label: ENVIRONMENT_ENGINE_LABELS.vllm,
      versionPlaceholder: "0.26.0",
      note: null,
    },
  },
  sglang: {
    ...descriptorIdentity("sglang"),
    instanceKind: "sglang",
    variants: ["cuda"],
    python: {
      versions: null,
      defaultVersion: ENVIRONMENT_DEFAULT_PYTHON_VERSION,
    },
    distributions: ["sglang"],
    defaultExtras: SGLANG_DEFAULT_EXTRAS,
    create: {
      label: ENVIRONMENT_ENGINE_LABELS.sglang,
      versionPlaceholder: "0.5.17",
      note: null,
    },
  },
  ktransformers: {
    ...descriptorIdentity("ktransformers"),
    instanceKind: "ktransformers",
    variants: ["cuda"],
    python: {
      versions: KTRANSFORMERS_PYTHON_VERSIONS,
      defaultVersion: ENVIRONMENT_DEFAULT_PYTHON_VERSION,
    },
    distributions: ["kt-kernel", "sglang-kt"],
    defaultExtras: [],
    create: {
      label: `${ENVIRONMENT_ENGINE_LABELS.ktransformers} (SGLang-KT)`,
      versionPlaceholder: "0.6.3.post1",
      note: `KTransformers requires Linux x86-64, Python ${KTRANSFORMERS_PYTHON_VERSIONS.join("/")}, and an NVIDIA CUDA GPU. kt-kernel and sglang-kt are installed at this exact shared version.`,
    },
  },
  "open-webui": {
    ...descriptorIdentity("open-webui"),
    instanceKind: null,
    variants: ["cpu"],
    python: {
      versions: OPEN_WEBUI_PYTHON_VERSIONS,
      defaultVersion: ENVIRONMENT_DEFAULT_PYTHON_VERSION,
    },
    distributions: ["open-webui"],
    defaultExtras: [],
    create: null,
  },
  "chat-ui": {
    ...descriptorIdentity("chat-ui"),
    instanceKind: null,
    variants: ["cpu"],
    python: null,
    distributions: [],
    defaultExtras: [],
    create: null,
  },
};

export function environmentDescriptor(
  engine: EnvironmentEngine,
): EnvironmentDescriptor {
  return ENVIRONMENT_DESCRIPTORS[engine];
}

export function environmentPypiRequirements(
  engine: EnvironmentEngine,
  version: string,
  extras: readonly string[],
): string[] {
  const extrasSuffix = extras.length ? `[${extras.join(",")}]` : "";
  return environmentDescriptor(engine).distributions.map(
    (distribution) => `${distribution}${extrasSuffix}==${version}`,
  );
}
