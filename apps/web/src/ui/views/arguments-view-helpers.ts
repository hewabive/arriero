import type {
  ArgumentDefault,
  ArgumentDefaults,
  ArgumentOption,
  LlamaArgumentPresetSupport,
} from "@llama-manager/core";

import { argumentDefaultFromOption } from "../utils/argument-defaults";

export const allFilterValue = "__all__";
export const emptyArgumentDefaults: ArgumentDefaults = {
  instance: [],
  updatedAt: null,
};

export function optionSearchText(option: ArgumentOption) {
  const withoutDashes = option.primaryName.replace(/^-+/, "");
  const dashVariant = withoutDashes ? `--${withoutDashes}` : null;
  return [
    option.primaryName,
    withoutDashes,
    dashVariant,
    option.names.join(" "),
    option.category,
    option.valueHint,
    option.valueType,
    option.control.presetSupport,
    option.env.join(" "),
    option.allowedValues.join(" "),
    option.help,
    option.helpRu,
    option.doc.summary,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function sourceColor(source: ArgumentOption["helpRuSource"]) {
  if (source === "registry") return "blue";
  if (source === "fallback") return "yellow";
  return "gray";
}

export function presetSupportLabel(support: LlamaArgumentPresetSupport) {
  if (support === "preset-only") return "preset only";
  if (support === "model-managed") return "managed field";
  if (support === "router-managed") return "router level";
  if (support === "unsupported") return "not for INI";
  return "INI";
}

export function presetSupportColor(support: LlamaArgumentPresetSupport) {
  if (support === "preset-only") return "blue";
  if (support === "model-managed") return "violet";
  if (support === "router-managed") return "orange";
  if (support === "unsupported") return "red";
  return "gray";
}

export function findInstanceDefault(
  defaults: ArgumentDefaults,
  option: ArgumentOption,
) {
  const key = argumentDefaultFromOption(option).key;
  return defaults.instance.find((item) => item.key === key) ?? null;
}

export function defaultScopeLabel(
  defaults: ArgumentDefaults,
  option: ArgumentOption,
) {
  return findInstanceDefault(defaults, option)
    ? "Default for new instances"
    : null;
}

export function canUseAsInstanceDefault(option: ArgumentOption) {
  return (
    option.primaryName.startsWith("-") &&
    option.control.presetSupport !== "model-managed" &&
    option.control.presetSupport !== "preset-only" &&
    option.control.presetSupport !== "unsupported"
  );
}

export function defaultUnavailableMessage(option: ArgumentOption) {
  if (canUseAsInstanceDefault(option)) {
    return null;
  }
  if (option.control.presetSupport === "model-managed") {
    return "This option is managed by a dedicated model field, so it is not added as a default instance argument.";
  }
  if (option.control.presetSupport === "preset-only") {
    return "This option only applies inside a model preset, not as a llama-server CLI argument.";
  }
  if (option.control.presetSupport === "router-managed") {
    return "This option belongs to the router process and is not added as a default instance argument.";
  }
  if (option.control.presetSupport === "unsupported") {
    return "This option is not supported as a default instance argument.";
  }
  return "This option is not available as a default instance argument in the reference catalog.";
}

export function upsertDefault(
  defaults: ArgumentDefault[],
  nextDefault: ArgumentDefault,
) {
  const rest = defaults.filter((item) => item.key !== nextDefault.key);
  return [...rest, nextDefault].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export function defaultDraftKey(key: string) {
  return key;
}

export function defaultNeedsValue(valueType: ArgumentDefault["valueType"]) {
  return valueType !== "flag" && valueType !== "null";
}

export function validateArgumentDefault(input: ArgumentDefault) {
  if (
    input.valueType === "number" &&
    input.value.trim() &&
    !Number.isFinite(Number(input.value))
  ) {
    return "Default value must be a number";
  }
  return null;
}

export function findOptionByRouteArg(
  options: ArgumentOption[],
  routeArg: string,
) {
  const normalizedRouteArg = routeArg.trim();
  const withoutDashes = normalizedRouteArg.replace(/^-+/, "");
  return (
    options.find(
      (option) =>
        option.primaryName === normalizedRouteArg ||
        option.names.includes(normalizedRouteArg),
    ) ??
    options.find(
      (option) =>
        option.primaryName.replace(/^-+/, "") === withoutDashes ||
        option.names.some((name) => name.replace(/^-+/, "") === withoutDashes),
    ) ??
    null
  );
}
