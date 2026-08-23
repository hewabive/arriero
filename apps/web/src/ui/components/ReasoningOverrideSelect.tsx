import {
  apiProxyReasoningPresets,
  type ApiProxyReasoningOverride,
} from "@arriero/core";

import { TouchSelect } from "./TouchCombobox";

const autoValue = "__auto";
const customValue = "__custom";

export function ReasoningOverrideSelect(props: {
  value: ApiProxyReasoningOverride | null;
  onChange: (value: ApiProxyReasoningOverride | null) => void;
  autoLabel: string;
  description: string;
}) {
  const value =
    props.value === null
      ? autoValue
      : props.value.kind === "preset"
        ? `preset:${props.value.preset}`
        : customValue;
  const options = [
    { value: autoValue, label: props.autoLabel },
    ...apiProxyReasoningPresets.map((entry) => ({
      value: `preset:${entry.id}`,
      label: entry.label,
    })),
    ...(props.value?.kind === "custom"
      ? [{ value: customValue, label: "Custom profile (via API)" }]
      : []),
  ];
  return (
    <TouchSelect
      label="Reasoning effort mapping"
      description={props.description}
      data={options}
      value={value}
      onChange={(next) => {
        if (next === customValue) {
          return;
        }
        props.onChange(
          next && next.startsWith("preset:")
            ? { kind: "preset", preset: next.slice("preset:".length) }
            : null,
        );
      }}
    />
  );
}
