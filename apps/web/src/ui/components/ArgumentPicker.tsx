import type { OptionsFilter } from "@mantine/core";
import { useMemo, useState } from "react";

import { TouchSelect } from "./TouchCombobox";

export type ArgumentPickerOption = {
  value: string;
  label: string;
  disabled?: boolean;
  searchTerms?: string[];
};

export function ArgumentPicker(props: {
  data: ArgumentPickerOption[];
  onPick: (value: string) => void;
  label?: string;
  isError?: boolean;
  isFetching?: boolean;
  errorPlaceholder?: string;
  searchPlaceholder?: string;
  nothingFoundMessage?: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  const data = useMemo(
    () => [
      ...new Map(
        props.data.map((option) => [option.value, option] as const),
      ).values(),
    ],
    [props.data],
  );

  const termsByValue = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const option of data) {
      map.set(
        option.value,
        (option.searchTerms ?? []).map((term) => term.toLowerCase()),
      );
    }
    return map;
  }, [data]);

  const filterOptions: OptionsFilter = ({ options, search }) => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return options;
    }
    const exact = options.filter(
      (item) =>
        "value" in item &&
        (termsByValue.get(item.value) ?? []).includes(normalized),
    );
    if (exact.length > 0) {
      return exact;
    }
    return options.filter(
      (item) =>
        "label" in item && item.label.toLowerCase().includes(normalized),
    );
  };

  return (
    <TouchSelect
      key={pickerKey}
      filter={filterOptions}
      label={props.label ?? "Add argument"}
      placeholder={
        props.isError
          ? (props.errorPlaceholder ?? "Unable to read --help from binary")
          : (props.searchPlaceholder ?? "Search arguments")
      }
      searchable
      clearable
      value={value}
      onChange={(next) => {
        if (!next) {
          setValue(null);
          return;
        }
        props.onPick(next);
        setValue(null);
        setPickerKey((key) => key + 1);
      }}
      data={data}
      nothingFoundMessage={
        props.nothingFoundMessage ??
        (props.isFetching ? "Loading..." : "No arguments found")
      }
      disabled={Boolean(props.isError)}
    />
  );
}
