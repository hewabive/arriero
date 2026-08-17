import type {
  Instance,
  ProcessPreflightIssue,
  SystemAccelerator,
} from "@arriero/core";
import { existsSync, readFileSync, statSync } from "node:fs";

import { getArgumentCatalogAsync } from "../arguments/catalog.js";
import { getSystemResources } from "../system/resources.js";
import type { PreflightOptions } from "./preflight.js";

function localPathCandidate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    return null;
  }
  return value;
}

function pushFileIssue(
  issues: ProcessPreflightIssue[],
  field: string,
  value: unknown,
  message: string,
) {
  const path = localPathCandidate(value);
  if (!path) {
    return;
  }

  if (!existsSync(path)) {
    issues.push({ level: "error", field, message: `${message}: ${path}` });
    return;
  }

  try {
    if (!statSync(path).isFile()) {
      issues.push({ level: "error", field, message: `Expected file: ${path}` });
    }
  } catch (error) {
    issues.push({
      level: "error",
      field,
      message: `Unable to inspect ${path}: ${(error as Error).message}`,
    });
  }
}

function hasConfiguredArg(instance: Instance, key: string) {
  const value = instance.args[key];
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function isDisabledArgValue(value: unknown) {
  return value === undefined || value === null || value === false;
}

function isEmptyArgValue(value: unknown) {
  if (value === undefined || value === null || value === false) {
    return true;
  }
  if (typeof value === "string") {
    return !value.trim();
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => !item.trim());
  }
  return false;
}

function argValueIsGpuLayerRequest(value: unknown) {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(argValueIsGpuLayerRequest);
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false") {
    return false;
  }
  return true;
}

const gpuLayerArgKeys = ["--n-gpu-layers", "--gpu-layers", "--ngl", "-ngl"];

function configuredGpuLayerArg(instance: Instance) {
  return gpuLayerArgKeys.find((key) =>
    argValueIsGpuLayerRequest(instance.args[key]),
  );
}

let acceleratorCache:
  | { checkedAtMs: number; accelerators: SystemAccelerator[] }
  | undefined;

function currentAccelerators(options: PreflightOptions) {
  if (options.accelerators) {
    return options.accelerators;
  }

  const now = Date.now();
  if (acceleratorCache && now - acceleratorCache.checkedAtMs < 5_000) {
    return acceleratorCache.accelerators;
  }

  const accelerators = getSystemResources().accelerators;
  acceleratorCache = { checkedAtMs: now, accelerators };
  return accelerators;
}

function hasCudaAccelerator(options: PreflightOptions) {
  return currentAccelerators(options).some(
    (accelerator) =>
      accelerator.kind === "gpu" && accelerator.vendor === "NVIDIA",
  );
}

function validateKnownPathArgs(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  pushFileIssue(
    issues,
    "args.--model",
    instance.args["--model"],
    "Model file not found",
  );
  pushFileIssue(
    issues,
    "args.--models-preset",
    instance.args["--models-preset"],
    "Models preset file not found",
  );
  pushFileIssue(
    issues,
    "args.--mmproj",
    instance.args["--mmproj"],
    "Multimodal projector file not found",
  );

  if (
    hasConfiguredArg(instance, "--model") &&
    hasConfiguredArg(instance, "--models-preset")
  ) {
    issues.push({
      level: "warning",
      field: "args.--models-preset",
      message:
        "llama-server enters router mode only when no --model is configured; with --model set, --models-preset is ignored.",
    });
  }

  if (
    !hasConfiguredArg(instance, "--model") &&
    !hasConfiguredArg(instance, "--models-preset") &&
    !hasConfiguredArg(instance, "--hf-repo") &&
    !hasConfiguredArg(instance, "--model-url")
  ) {
    issues.push({
      level: "error",
      field: "args",
      message:
        "No --model, --models-preset, --hf-repo or --model-url is configured",
    });
  }
}

function parseModelsPresetGpuLayerRequests(path: string) {
  const requests: Array<{ section: string; key: string; value: string }> = [];
  const contents = readFileSync(path, "utf8");
  let section = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }

    const keyValueMatch = /^([^=:#]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!keyValueMatch) {
      continue;
    }

    const key = keyValueMatch[1]!.trim().replace(/^-+/, "").toLowerCase();
    const value = keyValueMatch[2]!.trim();
    if (
      ["n-gpu-layers", "gpu-layers", "ngl"].includes(key) &&
      argValueIsGpuLayerRequest(value)
    ) {
      requests.push({
        section: section || "(root)",
        key,
        value,
      });
    }
  }

  return requests;
}

function formatPresetSections(sections: string[]) {
  const unique = [...new Set(sections)];
  if (unique.length <= 3) {
    return unique.join(", ");
  }
  return `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more`;
}

function validateGpuLayerRequests(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  if (hasCudaAccelerator(options)) {
    return;
  }

  const directGpuLayerArg = configuredGpuLayerArg(instance);
  if (directGpuLayerArg) {
    issues.push({
      level: "warning",
      field: `args.${directGpuLayerArg}`,
      message:
        "GPU layers are requested, but no NVIDIA GPU was detected through NVML; llama.cpp will likely ignore this option.",
    });
  }

  const presetPath = localPathCandidate(instance.args["--models-preset"]);
  if (!presetPath || !existsSync(presetPath)) {
    return;
  }

  try {
    if (!statSync(presetPath).isFile()) {
      return;
    }

    const presetRequests = parseModelsPresetGpuLayerRequests(presetPath);
    if (presetRequests.length === 0) {
      return;
    }

    issues.push({
      level: "warning",
      field: "args.--models-preset",
      message: `Models preset requests GPU layers for ${formatPresetSections(presetRequests.map((request) => request.section))}, but no NVIDIA GPU was detected through NVML; child llama-server processes will likely ignore n-gpu-layers.`,
    });
  } catch (error) {
    issues.push({
      level: "warning",
      field: "args.--models-preset",
      message: `Unable to inspect models preset GPU-layer settings: ${(error as Error).message}`,
    });
  }
}

async function validateArgumentCompatibility(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  let catalog: Awaited<ReturnType<typeof getArgumentCatalogAsync>>;
  try {
    catalog = await getArgumentCatalogAsync(instance.binaryPath, {
      docs: false,
    });
  } catch (error) {
    issues.push({
      level: "warning",
      field: "args",
      message: `Unable to inspect llama-server argument compatibility: ${(error as Error).message}`,
    });
    return;
  }

  const hasBinaryHelpOptions = catalog.options.some(
    (option) =>
      option.compatibility.presentInBinary &&
      option.compatibility.binaryNames.length > 0,
  );
  if (!hasBinaryHelpOptions) {
    return;
  }

  const optionByName = new Map(
    catalog.options.flatMap((option) => [
      [option.primaryName, option] as const,
      ...option.names.map((name) => [name, option] as const),
      ...option.compatibility.binaryNames.map(
        (name) => [name, option] as const,
      ),
    ]),
  );

  for (const key of Object.keys(instance.args)) {
    const value = instance.args[key];
    if (isDisabledArgValue(value)) {
      continue;
    }
    const option = optionByName.get(key);
    if (!option) {
      issues.push({
        level: "warning",
        field: `args.${key}`,
        message:
          "Argument was not found in the canonical registry or selected binary --help; llama-server may reject it at startup.",
      });
      continue;
    }
    if (
      option.valueType !== "flag" &&
      !(
        option.valueType === "boolean" &&
        !option.valueHint &&
        option.allowedValues.length === 0
      ) &&
      isEmptyArgValue(value)
    ) {
      issues.push({
        level: "error",
        field: `args.${key}`,
        message: `Argument ${option.primaryName} requires a value.`,
      });
      continue;
    }
    if (!option.compatibility.presentInBinary) {
      issues.push({
        level: "error",
        field: `args.${key}`,
        message: `Argument ${option.primaryName} is in the canonical registry, but is not supported by the selected binary.`,
      });
      continue;
    }
    if (
      option.compatibility.binaryNames.length === 0 &&
      !option.primaryName.startsWith("-")
    ) {
      issues.push({
        level: "error",
        field: `args.${key}`,
        message: `Argument ${option.primaryName} is a preset-only key and cannot be passed as a llama-server CLI argument. Put it in --models-preset instead.`,
      });
      continue;
    }
    if (
      key.startsWith("-") &&
      option.compatibility.binaryNames.length > 0 &&
      !option.compatibility.binaryNames.includes(key)
    ) {
      issues.push({
        level: "error",
        field: `args.${key}`,
        message: `Argument ${key} is known as ${option.primaryName}, but this selected binary does not expose that spelling in --help. Use one of: ${option.compatibility.binaryNames.join(", ")}.`,
      });
    }
  }
}

export async function validateLlamaServerPreflight(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  validateKnownPathArgs(instance, issues);
  await validateArgumentCompatibility(instance, issues);
  validateGpuLayerRequests(instance, issues, options);
}
