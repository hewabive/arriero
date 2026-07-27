import type { ArgumentOption } from "@arriero/core";
import {
  NumberInput,
  Select,
  Textarea,
  TextInput,
  type MantineSize,
} from "@mantine/core";
import type { CSSProperties } from "react";

import {
  argumentAcceptsAutoAll,
  defaultArgumentValue,
} from "../utils/argument-defaults";
import { TouchSelect } from "./TouchCombobox";

function booleanValueOptions(option: ArgumentOption) {
  if (option.allowedValues.length > 0) {
    return option.allowedValues.map((value) => ({ value, label: value }));
  }
  if (option.valueHint === "<0|1>") {
    return [
      { value: "1", label: "1" },
      { value: "0", label: "0" },
    ];
  }
  return [
    { value: "true", label: "true" },
    { value: "false", label: "false" },
  ];
}

function fallbackValue(option: ArgumentOption) {
  return defaultArgumentValue(option);
}

function commitOrFallback(
  value: string | null,
  option: ArgumentOption,
  allowEmpty: boolean,
) {
  return value ?? (allowEmpty ? "" : fallbackValue(option));
}

export function ArgumentValueControl(props: {
  option: ArgumentOption;
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  size?: MantineSize;
  style?: CSSProperties;
  w?: number | string;
  onBlur?: (value: string) => void;
}) {
  const allowEmpty = props.allowEmpty ?? false;
  const disabled = props.disabled ?? false;
  const size = props.size ?? "xs";
  const ariaLabel = props.ariaLabel ?? `${props.option.primaryName} value`;

  if (props.option.valueType === "flag") {
    return null;
  }

  if (props.option.valueType === "boolean") {
    const data =
      props.option.valueHint || props.option.allowedValues.length > 0
        ? booleanValueOptions(props.option)
        : [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ];
    return (
      <Select
        aria-label={ariaLabel}
        data={data}
        value={
          allowEmpty
            ? props.value || null
            : props.value ||
              fallbackValue(props.option) ||
              data[0]?.value ||
              "true"
        }
        placeholder={allowEmpty ? "not set" : undefined}
        allowDeselect={allowEmpty}
        clearable={allowEmpty}
        onChange={(value) =>
          props.onChange(commitOrFallback(value, props.option, allowEmpty))
        }
        onBlur={() => props.onBlur?.(props.value)}
        disabled={disabled}
        w={props.w ?? 120}
        style={props.style}
        size={size}
      />
    );
  }

  if (
    props.option.valueType === "enum" &&
    props.option.allowedValues.length > 0
  ) {
    return (
      <TouchSelect
        aria-label={ariaLabel}
        data={props.option.allowedValues.map((value) => ({
          value,
          label: value,
        }))}
        value={props.value || null}
        placeholder={allowEmpty ? "not set" : undefined}
        searchable
        clearable={allowEmpty}
        onChange={(value) => props.onChange(value ?? "")}
        onBlur={() => props.onBlur?.(props.value)}
        disabled={disabled}
        style={props.style ?? { flex: 1, minWidth: 160 }}
        w={props.w}
        size={size}
      />
    );
  }

  if (
    props.option.valueType === "number" &&
    !argumentAcceptsAutoAll(props.option)
  ) {
    return (
      <NumberInput
        aria-label={ariaLabel}
        value={props.value === "" ? "" : Number(props.value)}
        onChange={(value) =>
          props.onChange(typeof value === "number" ? String(value) : "")
        }
        onBlur={() => props.onBlur?.(props.value)}
        disabled={disabled}
        style={props.style ?? { flex: 1, minWidth: 110 }}
        w={props.w}
        size={size}
      />
    );
  }

  if (props.option.valueType === "json") {
    return (
      <Textarea
        aria-label={ariaLabel}
        minRows={2}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onBlur={(event) => props.onBlur?.(event.currentTarget.value)}
        disabled={disabled}
        style={props.style ?? { flex: 1, minWidth: 180 }}
        w={props.w}
        size={size}
      />
    );
  }

  return (
    <TextInput
      aria-label={ariaLabel}
      placeholder={
        props.option.valueType === "list"
          ? "a, b, c"
          : (props.option.valueHint ?? "value")
      }
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onBlur={(event) => props.onBlur?.(event.currentTarget.value)}
      disabled={disabled}
      style={props.style ?? { flex: 1, minWidth: 150 }}
      w={props.w}
      size={size}
    />
  );
}
