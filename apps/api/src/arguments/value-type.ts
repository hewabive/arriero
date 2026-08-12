import type { ArgumentValueType } from "@arriero/core";

const booleanChoiceValues = new Set([
  "on",
  "off",
  "auto",
  "0",
  "1",
  "true",
  "false",
]);

export function valueTypeFromChoices(
  allowedValues: string[],
): ArgumentValueType | null {
  if (allowedValues.length === 0) {
    return null;
  }
  return allowedValues.every((value) => booleanChoiceValues.has(value))
    ? "boolean"
    : "enum";
}
