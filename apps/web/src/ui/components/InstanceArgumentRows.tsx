import type { Instance, ArgumentOption } from "@arriero/core";
import { ActionIcon, Group, Select, TextInput, Tooltip } from "@mantine/core";
import { Trash2 } from "lucide-react";

import { createUiId } from "../utils/id";
import {
  argumentAcceptsAutoAll,
  defaultArgumentValue,
} from "../utils/argument-defaults";

export type ArgRow = {
  id: string;
  key: string;
  value: string;
  valueType: "string" | "number" | "boolean" | "flag" | "list" | "null";
};

const defaultArgRows: ArgRow[] = [
  { id: "host", key: "--host", value: "127.0.0.1", valueType: "string" },
  { id: "port", key: "--port", value: "8080", valueType: "number" },
];

export function defaultRows(modelPath?: string, port = 8080): ArgRow[] {
  const baseRows = defaultArgRows.map((row) =>
    row.key === "--port" ? { ...row, value: String(port) } : { ...row },
  );
  if (!modelPath) {
    return baseRows;
  }
  return [
    ...baseRows,
    { id: "model", key: "--model", value: modelPath, valueType: "string" },
  ];
}

export function createArgRow(): ArgRow {
  return {
    id: createUiId(),
    key: "",
    value: "",
    valueType: "string",
  };
}

function rowsToArgs(rows: ArgRow[]) {
  const args: Record<string, string | number | boolean | string[] | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      continue;
    }
    if (row.valueType === "flag") {
      args[key] = true;
    } else if (row.valueType === "null") {
      args[key] = null;
    } else if (row.valueType === "number") {
      if (!row.value.trim()) {
        throw new Error(`${key}: value must be a number`);
      }
      const parsed = Number(row.value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${key}: value must be a number`);
      }
      args[key] = parsed;
    } else if (row.valueType === "boolean") {
      args[key] = !row.value || row.value === "true";
    } else if (row.valueType === "list") {
      args[key] = row.value.trim();
    } else {
      args[key] = row.value;
    }
  }
  return args;
}

function negativeArgumentName(option: ArgumentOption) {
  return option.names.find(
    (name) => name.startsWith("--no-") || name.startsWith("-no"),
  );
}

function isPlainBoolean(option: ArgumentOption) {
  return (
    option.valueType === "boolean" &&
    !option.valueHint &&
    option.allowedValues.length === 0
  );
}

export function rowsToArgsWithCatalog(
  rows: ArgRow[],
  knownArgByName: Map<string, ArgumentOption>,
) {
  const args: Record<string, string | number | boolean | string[] | null> = {};

  for (const row of rows) {
    const option = knownArgByName.get(row.key.trim());
    if (!option) {
      Object.assign(args, rowsToArgs([row]));
      continue;
    }

    const primaryName = cliNameForArgument(option);
    if (row.valueType === "null") {
      args[primaryName] = null;
      continue;
    }

    if (option.valueType === "flag") {
      args[primaryName] = true;
      continue;
    }

    if (option.valueType === "boolean") {
      if (option.valueHint || option.allowedValues.length > 0) {
        args[primaryName] = row.value || option.allowedValues[0] || "on";
        continue;
      }

      const enabled = row.value !== "false";
      const negativeName = negativeArgumentName(option);
      if (enabled) {
        args[primaryName] = true;
      } else if (negativeName) {
        args[negativeName] = true;
      } else {
        args[primaryName] = false;
      }
      continue;
    }

    if (option.valueType === "number") {
      if (argumentAcceptsAutoAll(option)) {
        args[primaryName] = row.value;
        continue;
      }
      if (!row.value.trim()) {
        args[primaryName] = "";
        continue;
      }
      const parsed = Number(row.value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${primaryName}: value must be a number`);
      }
      args[primaryName] = parsed;
      continue;
    }

    if (option.valueType === "list") {
      args[primaryName] = row.value.trim();
      continue;
    }

    args[primaryName] = row.value;
  }

  return args;
}

export function upsertArgRow(
  rows: ArgRow[],
  key: string,
  value: string,
  valueType: ArgRow["valueType"],
): ArgRow[] {
  let replaced = false;
  const next = rows.map((row) => {
    if (row.key !== key) {
      return row;
    }
    replaced = true;
    return { ...row, value, valueType };
  });
  return replaced
    ? next
    : [...next, { id: createUiId(), key, value, valueType }];
}

export function removeArgRow(rows: ArgRow[], key: string): ArgRow[] {
  const next = rows.filter((row) => row.key !== key);
  return next.length > 0 ? next : [createArgRow()];
}

export function removeArgRows(rows: ArgRow[], keys: string[]): ArgRow[] {
  const keySet = new Set(keys);
  const next = rows.filter((row) => !keySet.has(row.key));
  return next.length > 0 ? next : [createArgRow()];
}

export function rowValue(rows: ArgRow[], key: string) {
  return rows.find((row) => row.key === key)?.value ?? "";
}

export function valueTypeFromArgument(
  option: ArgumentOption,
): ArgRow["valueType"] {
  if (option.valueType === "flag") return "flag";
  if (option.valueType === "boolean") return "boolean";
  if (argumentAcceptsAutoAll(option)) return "string";
  if (option.valueType === "number") return "number";
  if (option.valueType === "list") return "list";
  return "string";
}

export function defaultValueForArgument(option: ArgumentOption) {
  return defaultArgumentValue(option);
}

export function cliNameForArgument(option: ArgumentOption) {
  return option.compatibility.presentInBinary &&
    option.compatibility.binaryPrimaryName
    ? option.compatibility.binaryPrimaryName
    : option.primaryName;
}

function rowFromArgument(option: ArgumentOption): ArgRow {
  const valueType = valueTypeFromArgument(option);
  return {
    id: createUiId(),
    key: cliNameForArgument(option),
    value: defaultValueForArgument(option),
    valueType,
  };
}

export function canonicalOptionForRow(
  row: ArgRow,
  knownArgByName: Map<string, ArgumentOption>,
) {
  return knownArgByName.get(row.key.trim()) ?? null;
}

export function replaceCanonicalRow(rows: ArgRow[], option: ArgumentOption) {
  return [
    ...rows.filter(
      (row) =>
        canonicalOptionForRow(
          row,
          new Map(option.names.map((name) => [name, option])),
        )?.primaryName !== option.primaryName,
    ),
    rowFromArgument(option),
  ];
}

export function RawArgRow(props: {
  row: ArgRow;
  index: number;
  canRemove: boolean;
  onChange: (row: ArgRow) => void;
  onRemove: () => void;
}) {
  return (
    <Group gap="xs" align="center" wrap="wrap">
      <TextInput
        aria-label="Raw argument name"
        placeholder="--port"
        value={props.row.key}
        onChange={(event) =>
          props.onChange({ ...props.row, key: event.currentTarget.value })
        }
        style={{ flex: "1 1 180px" }}
        size="xs"
      />
      <Select
        aria-label="Raw argument type"
        data={[
          { value: "string", label: "string" },
          { value: "number", label: "number" },
          { value: "boolean", label: "boolean" },
          { value: "flag", label: "flag" },
          { value: "list", label: "list" },
          { value: "null", label: "disabled" },
        ]}
        value={props.row.valueType}
        allowDeselect={false}
        onChange={(value) =>
          props.onChange({
            ...props.row,
            valueType: (value ?? "string") as ArgRow["valueType"],
          })
        }
        w={115}
        size="xs"
      />
      {props.row.valueType === "boolean" ? (
        <Select
          aria-label="Raw argument value"
          data={[
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
          value={props.row.value || "true"}
          allowDeselect={false}
          onChange={(value) =>
            props.onChange({ ...props.row, value: value ?? "true" })
          }
          style={{ flex: "1 1 120px" }}
          size="xs"
        />
      ) : (
        <TextInput
          aria-label="Raw argument value"
          placeholder={
            props.row.valueType === "flag"
              ? "present"
              : props.row.valueType === "null"
                ? "disabled"
                : props.row.valueType === "list"
                  ? "a, b, c"
                  : "value"
          }
          value={props.row.value}
          disabled={
            props.row.valueType === "flag" || props.row.valueType === "null"
          }
          onChange={(event) =>
            props.onChange({ ...props.row, value: event.currentTarget.value })
          }
          style={{ flex: "1 1 160px" }}
          size="xs"
        />
      )}
      <Tooltip label="Remove">
        <ActionIcon
          aria-label="Remove raw argument"
          variant="subtle"
          color="red"
          disabled={!props.canRemove}
          onClick={props.onRemove}
        >
          <Trash2 size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

export function argsToRows(
  args: Instance["args"],
  knownArgByName?: Map<string, ArgumentOption>,
): ArgRow[] {
  const rows = Object.entries(args).map(([key, value]) => {
    const id = createUiId();
    const option = knownArgByName?.get(key.trim());
    if (option && isPlainBoolean(option) && typeof value === "boolean") {
      const isNegative = negativeArgumentName(option) === key.trim();
      const enabled = isNegative ? !value : value;
      return {
        id,
        key: cliNameForArgument(option),
        value: enabled ? "true" : "false",
        valueType: "boolean" as const,
      };
    }
    if (value === true) {
      return { id, key, value: "", valueType: "flag" as const };
    }
    if (value === null || value === false) {
      return { id, key, value: "", valueType: "null" as const };
    }
    if (typeof value === "number") {
      return { id, key, value: String(value), valueType: "number" as const };
    }
    if (typeof value === "boolean") {
      return { id, key, value: String(value), valueType: "boolean" as const };
    }
    if (Array.isArray(value)) {
      return { id, key, value: value.join(", "), valueType: "list" as const };
    }
    return { id, key, value: String(value), valueType: "string" as const };
  });

  return rows.length > 0 ? rows : [createArgRow()];
}
