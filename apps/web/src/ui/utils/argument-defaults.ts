import type { ArgumentDefault, ArgumentOption } from "@arriero/core";

export function argumentAcceptsAutoAll(option: ArgumentOption) {
  const name = option.primaryName.toLowerCase();
  return (
    name.includes("gpu-layers") &&
    /\bauto\b/i.test(option.help) &&
    /\ball\b/i.test(option.help)
  );
}

export function defaultArgumentValue(option: ArgumentOption) {
  if (argumentAcceptsAutoAll(option)) {
    return "auto";
  }
  if (option.valueType === "flag") {
    return "";
  }
  if (option.valueType === "boolean") {
    return option.allowedValues.includes("auto")
      ? "auto"
      : option.allowedValues[0] || "true";
  }
  return "";
}

function defaultArgumentValueType(
  option: ArgumentOption,
): ArgumentDefault["valueType"] {
  if (argumentAcceptsAutoAll(option)) {
    return "string";
  }
  if (option.valueType === "flag") return "flag";
  if (option.valueType === "boolean") return "boolean";
  if (option.valueType === "number") return "number";
  if (option.valueType === "list") return "list";
  return "string";
}

export function argumentDefaultFromOption(
  option: ArgumentOption,
): ArgumentDefault {
  return {
    key: option.primaryName,
    value: defaultArgumentValue(option),
    valueType: defaultArgumentValueType(option),
  };
}
